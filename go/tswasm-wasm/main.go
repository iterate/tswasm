//go:build js && wasm

package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"slices"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/diagnostics"
	"github.com/microsoft/typescript-go/internal/locale"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
)

const (
	defaultCurrentDirectory = "/"
	defaultInputFile        = "/input.ts"
)

//go:embed libs/*.d.ts
var standardLibs embed.FS

var standardLibraryCache struct {
	once        sync.Once
	sourceFiles map[string]string
	fileNames   []string
	err         error
}

type compileRequest struct {
	Code     string            `json:"code"`
	FileName string            `json:"fileName"`
	Files    map[string]string `json:"files"`
	TSConfig string            `json:"tsconfig"`
	Cwd      string            `json:"cwd"`
}

type compileResult struct {
	JS          string              `json:"js"`
	Outputs     map[string]string   `json:"outputs"`
	Diagnostics []compileDiagnostic `json:"diagnostics"`
	Success     bool                `json:"success"`
}

type compileDiagnostic struct {
	Message  string `json:"message"`
	Code     int    `json:"code"`
	Category string `json:"category"`
	FileName string `json:"fileName,omitempty"`
	Line     *int   `json:"line,omitempty"`
	Column   *int   `json:"column,omitempty"`
}

type parseConfigHost struct {
	fs               vfs.FS
	currentDirectory string
}

func main() {
	js.Global().Set("__tswasmCompile", js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return encodeResult(compileResult{
				Diagnostics: []compileDiagnostic{{
					Message:  "compile(request) expects one JSON string argument",
					Category: diagnostics.CategoryError.Name(),
				}},
				Success: false,
			})
		}

		var request compileRequest
		if err := json.Unmarshal([]byte(args[0].String()), &request); err != nil {
			return encodeResult(compileResult{
				Diagnostics: []compileDiagnostic{{
					Message:  "compile request must be JSON: " + err.Error(),
					Category: diagnostics.CategoryError.Name(),
				}},
				Success: false,
			})
		}

		return encodeResult(compileCode(request))
	}))

	select {}
}

func compileCode(request compileRequest) (result compileResult) {
	defer func() {
		if r := recover(); r != nil {
			result = compileResult{
				Diagnostics: []compileDiagnostic{{
					Message:  "typescript-go wasm panic: " + stringifyPanic(r),
					Category: diagnostics.CategoryError.Name(),
				}},
				Success: false,
			}
		}
	}()

	sourceFiles, fileNames, err := standardLibraryFiles()
	if err != nil {
		return compileResult{
			Diagnostics: []compileDiagnostic{{
				Message:  "typescript-go wasm could not load standard library: " + err.Error(),
				Category: diagnostics.CategoryError.Name(),
			}},
			Success: false,
		}
	}

	cwd := normalizeCurrentDirectory(request.Cwd)
	config, targetFile, singleInput, requestDiagnostics := prepareCompileConfig(request, sourceFiles, fileNames, cwd)
	if len(requestDiagnostics) > 0 {
		return compileResult{
			Outputs:     map[string]string{},
			Diagnostics: requestDiagnostics,
			Success:     false,
		}
	}

	host := compiler.NewCompilerHost(cwd, newInlineFS(sourceFiles), defaultCurrentDirectory, nil, nil)
	program := compiler.NewProgram(compiler.ProgramOptions{
		Config:         config,
		Host:           host,
		SingleThreaded: core.TSTrue,
	})
	var targetSourceFile *ast.SourceFile
	if singleInput {
		targetSourceFile = findSourceFile(program, targetFile)
	}
	if singleInput && targetSourceFile == nil {
		return compileResult{
			Outputs: map[string]string{},
			Diagnostics: []compileDiagnostic{{
				Message:  "typescript-go wasm did not load " + targetFile,
				Category: diagnostics.CategoryError.Name(),
			}},
			Success: false,
		}
	}

	ctx := context.Background()
	rawDiagnostics := compiler.GetDiagnosticsOfAnyProgram(
		ctx,
		program,
		targetSourceFile,
		false,
		program.GetBindDiagnostics,
		program.GetSemanticDiagnostics,
	)
	result.Diagnostics = formatDiagnostics(rawDiagnostics, cwd)

	outputs := map[string]string{}
	emitResult := program.Emit(ctx, compiler.EmitOptions{
		TargetSourceFile: targetSourceFile,
		WriteFile: func(fileName string, text string, data *compiler.WriteFileData) error {
			if strings.HasSuffix(fileName, ".js") {
				outputs[toResultFileName(fileName, cwd)] = text
			}
			return nil
		},
	})
	result.Outputs = outputs
	result.Diagnostics = append(result.Diagnostics, formatDiagnostics(emitResult.Diagnostics, cwd)...)
	if emitResult.EmitSkipped {
		return result
	}

	if singleInput {
		for _, text := range outputs {
			result.JS = text
			break
		}
	}
	result.Success = !hasError(result.Diagnostics)
	return result
}

func prepareCompileConfig(
	request compileRequest,
	sourceFiles map[string]string,
	standardLibraryFileNames []string,
	cwd string,
) (*tsoptions.ParsedCommandLine, string, bool, []compileDiagnostic) {
	if request.Files == nil {
		inputFile := normalizeInputFileName(request.FileName, defaultCurrentDirectory)
		sourceFiles[inputFile] = request.Code
		fileNames := append(slices.Clone(standardLibraryFileNames), inputFile)
		return newParsedCommandLine(defaultCompilerOptions(), fileNames), inputFile, true, nil
	}

	userFileNames := make([]string, 0, len(request.Files))
	configFileName := normalizeProjectConfigFileName(request.TSConfig, cwd)
	for fileName, contents := range request.Files {
		if fileName == "" {
			return nil, "", false, []compileDiagnostic{{
				Message:  "compile file map cannot include an empty file name",
				Category: diagnostics.CategoryError.Name(),
			}}
		}
		normalized := normalizeInputFileName(fileName, cwd)
		sourceFiles[normalized] = contents
		if isRootSourceFile(normalized, configFileName) {
			userFileNames = append(userFileNames, normalized)
		}
	}
	slices.Sort(userFileNames)

	configFileContents, hasConfig := sourceFiles[configFileName]
	if request.TSConfig != "" && !hasConfig {
		return nil, "", false, []compileDiagnostic{{
			Message:  "compile tsconfig file was not found in files: " + toResultFileName(configFileName, cwd),
			Category: diagnostics.CategoryError.Name(),
		}}
	}
	if hasConfig {
		config := parseVirtualTsConfig(configFileName, configFileContents, sourceFiles, cwd)
		applyCompilerDefaults(config.ParsedConfig.CompilerOptions)
		config.ParsedConfig.FileNames = mergeFileNames(standardLibraryFileNames, config.ParsedConfig.FileNames)
		return config, "", false, nil
	}

	if len(userFileNames) == 0 {
		return nil, "", false, []compileDiagnostic{{
			Message:  "compile file map must include at least one TypeScript source file",
			Category: diagnostics.CategoryError.Name(),
		}}
	}

	fileNames := mergeFileNames(standardLibraryFileNames, userFileNames)
	return newParsedCommandLine(defaultCompilerOptions(), fileNames), "", false, nil
}

func defaultCompilerOptions() *core.CompilerOptions {
	options := &core.CompilerOptions{}
	applyCompilerDefaults(options)
	return options
}

func applyCompilerDefaults(options *core.CompilerOptions) {
	if options.Target == core.ScriptTargetNone {
		options.Target = core.ScriptTargetES2024
	}
	if options.Module == core.ModuleKindNone {
		options.Module = core.ModuleKindESNext
	}
	if options.Strict == core.TSUnknown {
		options.Strict = core.TSTrue
	}
	if options.SourceMap == core.TSUnknown {
		options.SourceMap = core.TSFalse
	}
	if options.Declaration == core.TSUnknown {
		options.Declaration = core.TSFalse
	}
	options.NoLib = core.TSTrue
	options.SkipLibCheck = core.TSTrue
	options.SkipDefaultLibCheck = core.TSTrue
}

func newParsedCommandLine(options *core.CompilerOptions, fileNames []string) *tsoptions.ParsedCommandLine {
	return &tsoptions.ParsedCommandLine{
		ParsedConfig: &core.ParsedOptions{
			FileNames:       fileNames,
			CompilerOptions: options,
		},
	}
}

func parseVirtualTsConfig(
	configFileName string,
	contents string,
	sourceFiles map[string]string,
	cwd string,
) *tsoptions.ParsedCommandLine {
	host := &parseConfigHost{
		fs:               newInlineFS(sourceFiles),
		currentDirectory: cwd,
	}
	configDir := tspath.GetDirectoryPath(configFileName)
	configSourceFile := tsoptions.NewTsconfigSourceFileFromFilePath(
		configFileName,
		tspath.ToPath(configFileName, cwd, true),
		contents,
	)
	return tsoptions.ParseJsonSourceFileConfigFileContent(
		configSourceFile,
		host,
		configDir,
		nil,
		nil,
		configFileName,
		nil,
		nil,
		nil,
	)
}

func normalizeCurrentDirectory(cwd string) string {
	if cwd == "" {
		return defaultCurrentDirectory
	}
	return tspath.GetNormalizedAbsolutePath(cwd, defaultCurrentDirectory)
}

func normalizeProjectConfigFileName(tsconfig string, cwd string) string {
	if tsconfig == "" {
		return normalizeInputFileName("tsconfig.json", cwd)
	}
	return normalizeInputFileName(tsconfig, cwd)
}

func normalizeInputFileName(fileName string, cwd string) string {
	if fileName == "" {
		return defaultInputFile
	}
	return tspath.GetNormalizedAbsolutePath(fileName, cwd)
}

func isRootSourceFile(fileName string, configFileName string) bool {
	if fileName == configFileName || strings.Contains(fileName, "/node_modules/") {
		return false
	}
	return strings.HasSuffix(fileName, ".ts") ||
		strings.HasSuffix(fileName, ".tsx") ||
		strings.HasSuffix(fileName, ".mts") ||
		strings.HasSuffix(fileName, ".cts") ||
		strings.HasSuffix(fileName, ".js") ||
		strings.HasSuffix(fileName, ".jsx") ||
		strings.HasSuffix(fileName, ".mjs") ||
		strings.HasSuffix(fileName, ".cjs")
}

func mergeFileNames(first []string, second []string) []string {
	merged := make([]string, 0, len(first)+len(second))
	seen := map[string]struct{}{}
	for _, fileName := range append(slices.Clone(first), second...) {
		if _, ok := seen[fileName]; ok {
			continue
		}
		seen[fileName] = struct{}{}
		merged = append(merged, fileName)
	}
	return merged
}

func standardLibraryFiles() (map[string]string, []string, error) {
	standardLibraryCache.once.Do(loadStandardLibraryFiles)
	if standardLibraryCache.err != nil {
		return nil, nil, standardLibraryCache.err
	}

	sourceFiles := make(map[string]string, len(standardLibraryCache.sourceFiles)+1)
	for fileName, contents := range standardLibraryCache.sourceFiles {
		sourceFiles[fileName] = contents
	}
	fileNames := slices.Clone(standardLibraryCache.fileNames)

	return sourceFiles, fileNames, nil
}

func loadStandardLibraryFiles() {
	entries, err := standardLibs.ReadDir("libs")
	if err != nil {
		standardLibraryCache.err = err
		return
	}

	sourceFiles := make(map[string]string, len(entries)+1)
	fileNames := make([]string, 0, len(entries)+1)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".d.ts") {
			continue
		}

		contents, err := standardLibs.ReadFile("libs/" + entry.Name())
		if err != nil {
			standardLibraryCache.err = err
			return
		}

		fileName := "/" + entry.Name()
		sourceFiles[fileName] = string(contents)
		fileNames = append(fileNames, fileName)
	}
	slices.Sort(fileNames)

	standardLibraryCache.sourceFiles = sourceFiles
	standardLibraryCache.fileNames = fileNames
}

func findSourceFile(program *compiler.Program, fileName string) *ast.SourceFile {
	for _, sourceFile := range program.SourceFiles() {
		if sourceFile.FileName() == fileName {
			return sourceFile
		}
	}
	return nil
}

func formatDiagnostics(rawDiagnostics []*ast.Diagnostic, cwd string) []compileDiagnostic {
	formatted := make([]compileDiagnostic, 0, len(rawDiagnostics))
	for _, raw := range rawDiagnostics {
		diagnostic := compileDiagnostic{
			Message:  flattenDiagnostic(raw),
			Code:     int(raw.Code()),
			Category: raw.Category().Name(),
		}

		if file := raw.File(); file != nil {
			diagnostic.FileName = toResultFileName(file.FileName(), cwd)
			if raw.Pos() >= 0 {
				line, column := lineAndColumn(file, raw.Pos())
				diagnostic.Line = &line
				diagnostic.Column = &column
			}
		}

		formatted = append(formatted, diagnostic)
	}
	return formatted
}

func toResultFileName(fileName string, cwd string) string {
	trimmedCwd := strings.TrimRight(cwd, "/")
	if trimmedCwd != "" && trimmedCwd != "/" {
		prefix := trimmedCwd + "/"
		if strings.HasPrefix(fileName, prefix) {
			return strings.TrimPrefix(fileName, prefix)
		}
	}
	return strings.TrimPrefix(fileName, "/")
}

func (h *parseConfigHost) FS() vfs.FS {
	return h.fs
}

func (h *parseConfigHost) GetCurrentDirectory() string {
	return h.currentDirectory
}

func flattenDiagnostic(diagnostic *ast.Diagnostic) string {
	message := diagnostic.Localize(locale.Default)
	for _, next := range diagnostic.MessageChain() {
		message += "\n  " + flattenDiagnostic(next)
	}
	return message
}

func lineAndColumn(file *ast.SourceFile, position int) (int, int) {
	lineStarts := file.ECMALineMap()
	line, byteOffset := core.PositionToLineAndByteOffset(position, lineStarts)
	positionMap := file.GetPositionMap()
	if positionMap.IsAsciiOnly() {
		return line + 1, byteOffset
	}

	lineStartUTF16 := positionMap.UTF8ToUTF16(int(lineStarts[line]))
	positionUTF16 := positionMap.UTF8ToUTF16(position)
	return line + 1, int(positionUTF16 - lineStartUTF16)
}

func hasError(items []compileDiagnostic) bool {
	return slices.ContainsFunc(items, func(diagnostic compileDiagnostic) bool {
		return diagnostic.Category == diagnostics.CategoryError.Name()
	})
}

func encodeResult(result compileResult) string {
	if result.Outputs == nil {
		result.Outputs = map[string]string{}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		encoded, _ = json.Marshal(compileResult{
			Outputs: map[string]string{},
			Diagnostics: []compileDiagnostic{{
				Message:  "failed to encode compiler result: " + err.Error(),
				Category: diagnostics.CategoryError.Name(),
			}},
			Success: false,
		})
	}
	return string(encoded)
}

func stringifyPanic(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case error:
		return typed.Error()
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "unknown panic"
		}
		return string(encoded)
	}
}

type inlineFS struct {
	files map[string]string
}

func newInlineFS(files map[string]string) *inlineFS {
	return &inlineFS{files: files}
}

func (f *inlineFS) UseCaseSensitiveFileNames() bool {
	return true
}

func (f *inlineFS) FileExists(path string) bool {
	_, ok := f.files[path]
	return ok
}

func (f *inlineFS) ReadFile(path string) (string, bool) {
	contents, ok := f.files[path]
	return contents, ok
}

func (f *inlineFS) WriteFile(path string, data string) error {
	f.files[path] = data
	return nil
}

func (f *inlineFS) AppendFile(path string, data string) error {
	f.files[path] += data
	return nil
}

func (f *inlineFS) Remove(path string) error {
	delete(f.files, path)
	return nil
}

func (f *inlineFS) Chtimes(path string, aTime time.Time, mTime time.Time) error {
	if !f.FileExists(path) {
		return vfs.ErrNotExist
	}
	return nil
}

func (f *inlineFS) DirectoryExists(path string) bool {
	if path == "/" || path == "" {
		return true
	}
	prefix := strings.TrimRight(path, "/") + "/"
	for fileName := range f.files {
		if strings.HasPrefix(fileName, prefix) {
			return true
		}
	}
	return false
}

func (f *inlineFS) GetAccessibleEntries(path string) vfs.Entries {
	prefix := strings.TrimRight(path, "/")
	if prefix == "" {
		prefix = "/"
	}
	if prefix != "/" {
		prefix += "/"
	}

	var entries vfs.Entries
	seenDirectories := map[string]struct{}{}
	for fileName := range f.files {
		if !strings.HasPrefix(fileName, prefix) {
			continue
		}
		rest := strings.TrimPrefix(fileName, prefix)
		if rest == "" {
			continue
		}
		name, child, found := strings.Cut(rest, "/")
		if found {
			if _, ok := seenDirectories[name]; !ok {
				seenDirectories[name] = struct{}{}
				entries.Directories = append(entries.Directories, name)
			}
			_ = child
			continue
		}
		entries.Files = append(entries.Files, name)
	}
	slices.Sort(entries.Files)
	slices.Sort(entries.Directories)
	return entries
}

func (f *inlineFS) Stat(path string) vfs.FileInfo {
	if contents, ok := f.files[path]; ok {
		return inlineFileInfo{name: tspath.GetBaseFileName(path), size: int64(len(contents))}
	}
	if f.DirectoryExists(path) {
		return inlineFileInfo{name: tspath.GetBaseFileName(path), dir: true}
	}
	return nil
}

func (f *inlineFS) WalkDir(root string, walkFn vfs.WalkDirFunc) error {
	if !f.DirectoryExists(root) {
		return vfs.ErrNotExist
	}
	root = strings.TrimRight(root, "/")
	if root == "" {
		root = "/"
	}
	for fileName := range f.files {
		if root != "/" && !strings.HasPrefix(fileName, root+"/") {
			continue
		}
		info := f.Stat(fileName)
		if info == nil {
			continue
		}
		if err := walkFn(fileName, fs.FileInfoToDirEntry(info), nil); err != nil {
			if errors.Is(err, fs.SkipDir) {
				continue
			}
			return err
		}
	}
	return nil
}

func (f *inlineFS) Realpath(path string) string {
	return path
}

type inlineFileInfo struct {
	name string
	size int64
	dir  bool
}

func (info inlineFileInfo) Name() string {
	return info.name
}

func (info inlineFileInfo) Size() int64 {
	return info.size
}

func (info inlineFileInfo) Mode() fs.FileMode {
	if info.dir {
		return fs.ModeDir | 0o555
	}
	return 0o444
}

func (info inlineFileInfo) ModTime() time.Time {
	return time.Time{}
}

func (info inlineFileInfo) IsDir() bool {
	return info.dir
}

func (info inlineFileInfo) Sys() any {
	return nil
}
