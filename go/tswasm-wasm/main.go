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
	currentDirectory = "/"
	defaultInputFile = "/input.ts"
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
	Code          string `json:"code"`
	FileName      string `json:"fileName"`
	BenchmarkMode string `json:"benchmarkMode"`
}

type compileResult struct {
	JS          string              `json:"js"`
	Diagnostics []compileDiagnostic `json:"diagnostics"`
	Success     bool                `json:"success"`
}

type compileDiagnostic struct {
	Message  string `json:"message"`
	Code     int    `json:"code"`
	Category string `json:"category"`
	Line     *int   `json:"line,omitempty"`
	Column   *int   `json:"column,omitempty"`
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

	inputFile := request.FileName
	if inputFile == "" {
		inputFile = defaultInputFile
	}
	if !strings.HasPrefix(inputFile, "/") {
		inputFile = "/" + inputFile
	}
	if request.BenchmarkMode == "roundTrip" {
		return compileResult{
			JS:      request.Code,
			Success: true,
		}
	}

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
	if request.BenchmarkMode == "standardLibraryFiles" {
		return compileResult{
			JS:      strings.Join(fileNames, "\n"),
			Success: true,
		}
	}
	sourceFiles[inputFile] = request.Code
	fileNames = append(fileNames, inputFile)

	options := &core.CompilerOptions{
		Target:              core.ScriptTargetES2024,
		Module:              core.ModuleKindESNext,
		NoLib:               core.TSTrue,
		SkipLibCheck:        core.TSTrue,
		Strict:              core.TSTrue,
		SkipDefaultLibCheck: core.TSTrue,
		SourceMap:           core.TSFalse,
		Declaration:         core.TSFalse,
	}
	config := &tsoptions.ParsedCommandLine{
		ParsedConfig: &core.ParsedOptions{
			FileNames:       fileNames,
			CompilerOptions: options,
		},
	}
	host := compiler.NewCompilerHost(currentDirectory, newInlineFS(sourceFiles), currentDirectory, nil, nil)
	singleThreaded := core.TSTrue
	if request.BenchmarkMode == "parallelProgram" {
		singleThreaded = core.TSFalse
	}
	program := compiler.NewProgram(compiler.ProgramOptions{
		Config:         config,
		Host:           host,
		SingleThreaded: singleThreaded,
	})
	sourceFile := findSourceFile(program, inputFile)
	if sourceFile == nil {
		return compileResult{
			Diagnostics: []compileDiagnostic{{
				Message:  "typescript-go wasm did not load " + inputFile,
				Category: diagnostics.CategoryError.Name(),
			}},
			Success: false,
		}
	}
	if request.BenchmarkMode == "programSetup" {
		return compileResult{
			JS:      inputFile,
			Success: true,
		}
	}

	ctx := context.Background()
	if request.BenchmarkMode != "emitOnly" {
		rawDiagnostics := compiler.GetDiagnosticsOfAnyProgram(
			ctx,
			program,
			sourceFile,
			false,
			program.GetBindDiagnostics,
			program.GetSemanticDiagnostics,
		)
		result.Diagnostics = formatDiagnostics(rawDiagnostics)
		if request.BenchmarkMode == "diagnosticsOnly" {
			result.JS = inputFile
			result.Success = !hasError(result.Diagnostics)
			return result
		}
	}

	var jsText string
	emitResult := program.Emit(ctx, compiler.EmitOptions{
		TargetSourceFile: sourceFile,
		WriteFile: func(fileName string, text string, data *compiler.WriteFileData) error {
			if strings.HasSuffix(fileName, ".js") {
				jsText = text
			}
			return nil
		},
	})
	result.Diagnostics = append(result.Diagnostics, formatDiagnostics(emitResult.Diagnostics)...)
	if emitResult.EmitSkipped {
		return result
	}

	result.JS = jsText
	result.Success = !hasError(result.Diagnostics)
	return result
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

func formatDiagnostics(rawDiagnostics []*ast.Diagnostic) []compileDiagnostic {
	formatted := make([]compileDiagnostic, 0, len(rawDiagnostics))
	for _, raw := range rawDiagnostics {
		diagnostic := compileDiagnostic{
			Message:  flattenDiagnostic(raw),
			Code:     int(raw.Code()),
			Category: raw.Category().Name(),
		}

		if file := raw.File(); file != nil && raw.Pos() >= 0 {
			line, column := lineAndColumn(file, raw.Pos())
			diagnostic.Line = &line
			diagnostic.Column = &column
		}

		formatted = append(formatted, diagnostic)
	}
	return formatted
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
	encoded, err := json.Marshal(result)
	if err != nil {
		encoded, _ = json.Marshal(compileResult{
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
