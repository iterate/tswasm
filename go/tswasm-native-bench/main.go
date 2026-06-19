package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"strings"
	"sync"
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
	JS          string   `json:"js"`
	Diagnostics []string `json:"diagnostics"`
	Success     bool     `json:"success"`
}

type benchmarkSummary struct {
	Samples  int     `json:"samples"`
	MeanMs   float64 `json:"meanMs"`
	MedianMs float64 `json:"medianMs"`
	MinMs    float64 `json:"minMs"`
	MaxMs    float64 `json:"maxMs"`
	Hz       float64 `json:"hz"`
}

func main() {
	codePath := flag.String("file", "", "TypeScript source file to compile")
	fileName := flag.String("fileName", defaultInputFile, "virtual file name")
	iterations := flag.Int("iterations", 5, "timed compile iterations")
	benchmarkMode := flag.String("benchmarkMode", "", "internal benchmark mode")
	flag.Parse()

	if *codePath == "" {
		fmt.Fprintln(os.Stderr, "--file is required")
		os.Exit(2)
	}

	code, err := os.ReadFile(*codePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	request := compileRequest{
		Code:          string(code),
		FileName:      *fileName,
		BenchmarkMode: *benchmarkMode,
	}
	if result := compileCode(request); !result.Success {
		_ = json.NewEncoder(os.Stderr).Encode(result)
		os.Exit(1)
	}

	samples := make([]float64, 0, *iterations)
	for range *iterations {
		start := time.Now()
		result := compileCode(request)
		if !result.Success {
			_ = json.NewEncoder(os.Stderr).Encode(result)
			os.Exit(1)
		}
		samples = append(samples, float64(time.Since(start).Nanoseconds())/1_000_000)
	}

	if err := json.NewEncoder(os.Stdout).Encode(summarize(samples)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func compileCode(request compileRequest) (result compileResult) {
	defer func() {
		if r := recover(); r != nil {
			result = compileResult{
				Diagnostics: []string{"typescript-go native helper panic: " + stringifyPanic(r)},
				Success:     false,
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
			Diagnostics: []string{"could not load standard library: " + err.Error()},
			Success:     false,
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
	program := compiler.NewProgram(compiler.ProgramOptions{
		Config:         config,
		Host:           host,
		SingleThreaded: core.TSTrue,
	})
	sourceFile := findSourceFile(program, inputFile)
	if sourceFile == nil {
		return compileResult{
			Diagnostics: []string{"typescript-go native helper did not load " + inputFile},
			Success:     false,
		}
	}
	if request.BenchmarkMode == "programSetup" {
		return compileResult{
			JS:      inputFile,
			Success: true,
		}
	}

	ctx := context.Background()
	hasErrors := false
	if request.BenchmarkMode != "emitOnly" {
		rawDiagnostics := compiler.GetDiagnosticsOfAnyProgram(
			ctx,
			program,
			sourceFile,
			false,
			program.GetBindDiagnostics,
			program.GetSemanticDiagnostics,
		)
		hasErrors = hasDiagnosticError(rawDiagnostics)
		result.Diagnostics = formatDiagnostics(rawDiagnostics)
		if request.BenchmarkMode == "diagnosticsOnly" {
			result.JS = inputFile
			result.Success = !hasErrors
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
	if hasDiagnosticError(emitResult.Diagnostics) {
		hasErrors = true
	}
	result.Diagnostics = append(result.Diagnostics, formatDiagnostics(emitResult.Diagnostics)...)
	if emitResult.EmitSkipped {
		return result
	}

	result.JS = jsText
	result.Success = !hasErrors
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

func hasDiagnosticError(items []*ast.Diagnostic) bool {
	return slices.ContainsFunc(items, func(diagnostic *ast.Diagnostic) bool {
		return diagnostic.Category() == diagnostics.CategoryError
	})
}

func formatDiagnostics(rawDiagnostics []*ast.Diagnostic) []string {
	formatted := make([]string, 0, len(rawDiagnostics))
	for _, raw := range rawDiagnostics {
		formatted = append(formatted, raw.Localize(locale.Default))
	}
	return formatted
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

func summarize(samples []float64) benchmarkSummary {
	slices.Sort(samples)
	sum := 0.0
	for _, sample := range samples {
		sum += sample
	}
	mean := sum / float64(len(samples))
	return benchmarkSummary{
		Samples:  len(samples),
		MeanMs:   mean,
		MedianMs: percentile(samples, 0.5),
		MinMs:    samples[0],
		MaxMs:    samples[len(samples)-1],
		Hz:       1000 / mean,
	}
}

func percentile(sorted []float64, p float64) float64 {
	index := float64(len(sorted)-1) * p
	lower := int(index)
	upper := lower
	if float64(upper) < index {
		upper++
	}
	if lower == upper {
		return sorted[lower]
	}
	return sorted[lower] + (sorted[upper]-sorted[lower])*(index-float64(lower))
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
