using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CsharpAstAnalyzer
{
    class Program
    {
        static void Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.WriteLine("Usage: CsharpAstAnalyzer <projectDir> <file1.cs> [file2.cs] ...");
                return;
            }

            string projectDir = args[0];
            var files = args.Skip(1).ToArray();

            var result = new AnalysisResult
            {
                Language = "csharp",
                ProjectRoot = projectDir,
                AnalyzedAt = DateTime.UtcNow.ToString("O"),
                Modules = new List<ModuleSummary>(),
                DependencyGraph = new List<ImportEdge>(),
                Patterns = new List<PatternMatch>(),
                EntryPoints = new List<string>(),
                CircularDependencies = new List<List<string>>(),
                Stats = new Stats()
            };

            var allImports = new List<ImportEdge>();
            var allPatterns = new List<PatternMatch>();

            foreach (var file in files)
            {
                if (!File.Exists(file)) continue;

                var relPath = Path.GetRelativePath(projectDir, file).Replace("\\", "/");
                var code = File.ReadAllText(file);
                var tree = CSharpSyntaxTree.ParseText(code);
                var root = tree.GetCompilationUnitRoot();

                var exports = new List<ExportedSymbol>();
                var imports = new List<ImportEdge>();
                bool hasTests = false;

                // Imports
                var usingDirectives = root.DescendantNodes().OfType<UsingDirectiveSyntax>();
                var importedNamespaces = new List<string>();
                foreach (var usingDirective in usingDirectives)
                {
                    var name = usingDirective.Name?.ToString();
                    if (!string.IsNullOrEmpty(name))
                    {
                        importedNamespaces.Add(name);
                    }
                }

                if (importedNamespaces.Any())
                {
                    var edge = new ImportEdge
                    {
                        From = relPath,
                        To = string.Join(", ", importedNamespaces),
                        Symbols = importedNamespaces,
                        IsExternal = importedNamespaces.Any(n => n.StartsWith("System") || n.StartsWith("Microsoft"))
                    };
                    imports.Add(edge);
                    allImports.Add(edge);
                }

                // Exports & Patterns
                var typeDeclarations = root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>();
                foreach (var declaration in typeDeclarations)
                {
                    bool isPublic = declaration.Modifiers.Any(m => m.IsKind(SyntaxKind.PublicKeyword));
                    
                    exports.Add(new ExportedSymbol
                    {
                        Name = declaration.Identifier.Text,
                        Kind = GetKind(declaration),
                        Filepath = relPath,
                        Line = declaration.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                        Signature = $"{GetKind(declaration)} {declaration.Identifier.Text}",
                        IsExported = isPublic
                    });

                    // Patterns
                    var hasFact = declaration.DescendantNodes().OfType<AttributeSyntax>()
                        .Any(a => a.Name.ToString().Contains("Fact") || a.Name.ToString().Contains("Test"));
                    if (hasFact) hasTests = true;

                    var methods = declaration.DescendantNodes().OfType<MethodDeclarationSyntax>();
                    if (methods.Any(m => m.AttributeLists.SelectMany(al => al.Attributes).Any(a => a.Name.ToString().Contains("Fact") || a.Name.ToString().Contains("Test"))))
                    {
                        hasTests = true;
                    }

                    if (declaration.BaseList != null)
                    {
                        foreach (var baseType in declaration.BaseList.Types)
                        {
                            var baseName = baseType.Type.ToString();
                            if (baseName.Contains("Controller"))
                            {
                                allPatterns.Add(new PatternMatch { Pattern = "MVC Controller", Filepath = relPath, Evidence = $"Inherits from {baseName}" });
                            }
                            if (baseName.Contains("DbContext"))
                            {
                                allPatterns.Add(new PatternMatch { Pattern = "Entity Framework DbContext", Filepath = relPath, Evidence = $"Inherits from {baseName}" });
                            }
                        }
                    }

                    if (declaration.Identifier.Text.EndsWith("Repository"))
                    {
                        allPatterns.Add(new PatternMatch { Pattern = "Repository", Filepath = relPath, Evidence = $"Class name ends with Repository" });
                    }
                }

                var module = new ModuleSummary
                {
                    Filepath = relPath,
                    Exports = exports,
                    Imports = imports,
                    LinesOfCode = code.Split('\n').Length,
                    HasTests = hasTests || relPath.ToLower().Contains("test")
                };

                result.Modules.Add(module);
            }

            result.DependencyGraph = allImports;
            result.Patterns = allPatterns;
            result.Stats.TotalFiles = result.Modules.Count;
            result.Stats.TotalExports = result.Modules.Sum(m => m.Exports.Count);
            result.Stats.TotalImports = result.Modules.Sum(m => m.Imports.Count);
            result.Stats.FilesWithTests = result.Modules.Count(m => m.HasTests);
            result.Stats.FilesWithoutTests = result.Stats.TotalFiles - result.Stats.FilesWithTests;

            var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
            Console.WriteLine(JsonSerializer.Serialize(result, options));
        }

        static string GetKind(BaseTypeDeclarationSyntax syntax)
        {
            if (syntax is ClassDeclarationSyntax) return "class";
            if (syntax is InterfaceDeclarationSyntax) return "interface";
            if (syntax is EnumDeclarationSyntax) return "enum";
            if (syntax is StructDeclarationSyntax) return "struct";
            if (syntax is RecordDeclarationSyntax) return "record";
            return "unknown";
        }
    }

    public class ExportedSymbol
    {
        public string Name { get; set; }
        public string Kind { get; set; }
        public string Filepath { get; set; }
        public int Line { get; set; }
        public string Signature { get; set; }
        public bool IsExported { get; set; }
    }

    public class ImportEdge
    {
        public string From { get; set; }
        public string To { get; set; }
        public List<string> Symbols { get; set; }
        public bool IsExternal { get; set; }
    }

    public class ModuleSummary
    {
        public string Filepath { get; set; }
        public List<ExportedSymbol> Exports { get; set; }
        public List<ImportEdge> Imports { get; set; }
        public int LinesOfCode { get; set; }
        public bool HasTests { get; set; }
    }

    public class PatternMatch
    {
        public string Pattern { get; set; }
        public string Filepath { get; set; }
        public string Evidence { get; set; }
    }

    public class Stats
    {
        public int TotalFiles { get; set; }
        public int TotalExports { get; set; }
        public int TotalImports { get; set; }
        public int FilesWithTests { get; set; }
        public int FilesWithoutTests { get; set; }
    }

    public class AnalysisResult
    {
        public string Language { get; set; }
        public string ProjectRoot { get; set; }
        public string AnalyzedAt { get; set; }
        public List<ModuleSummary> Modules { get; set; }
        public List<ImportEdge> DependencyGraph { get; set; }
        public List<PatternMatch> Patterns { get; set; }
        public List<string> EntryPoints { get; set; }
        public List<List<string>> CircularDependencies { get; set; }
        public Stats Stats { get; set; }
    }
}
