import { minimatch } from "minimatch";
import * as vscode from "vscode";

import type {
  Configuration,
  DecorationGroup,
  DecorationOptions,
  DocumentDecorations,
  Rule,
} from "./types";

const extensionConfigurationName = "colorMyTextExtended";
const extensionName = "Color My Text Extended";

let logger = vscode.window.createOutputChannel(extensionName, {
  log: true,
});

// pattern -> regex cache
const regexes = new Map<string, RegExp>();

// document uri -> decorations
let documentDecorations = new Map<vscode.Uri, DocumentDecorations>();

let sharedDecorations = new Map<string, DecorationOptions>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    logger,

    vscode.window.onDidChangeVisibleTextEditors(updateDecorations),

    vscode.workspace.onDidChangeConfiguration(handleConfigurationChange),
    vscode.workspace.onDidSaveTextDocument(updateDecorations),

    vscode.languages.registerHoverProvider("plaintext", {
      provideHover: decoratedGroupHoverProvider,
    })
  );

  updateDecorations();

  logger.info(`Extension "${extensionConfigurationName}" activated!`);
}

const handleConfigurationChange = (event: vscode.ConfigurationChangeEvent) => {
  if (event.affectsConfiguration(extensionConfigurationName)) {
    updateDecorations();
  }
};

const decoratedGroupHoverProvider = (
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): vscode.Hover | undefined => {
  const decoratedRangeGroups = documentDecorations.get(
    document.uri
  )?.decoratedRangeGroups;

  if (!decoratedRangeGroups) return;

  // Consider using interval tree. This _very_ inefficient but seems ok for now.
  for (const [range, [group, decoration]] of decoratedRangeGroups) {
    if (token.isCancellationRequested) return;
    if (!range.contains(position)) continue;

    const hoverLines = [`Group: \`${group}\``];

    if (decoration.description)
      hoverLines.push(`Description: ${decoration.description}`);

    return new vscode.Hover(
      hoverLines.map((line) => new vscode.MarkdownString(line)),
      range
    );
  }
};

const getConfiguration = () =>
  vscode.workspace
    .getConfiguration(extensionConfigurationName)
    .get<Configuration[]>("configurations");

const getSharedDecorations = () =>
  vscode.workspace
    .getConfiguration(extensionConfigurationName)
    .get<object>("decorations");

const forEachVisibleApplicableEditor = (
  callback: (editor: vscode.TextEditor, rules: Rule[]) => void
) => {
  const todoEditors = vscode.window.visibleTextEditors.slice();

  if (todoEditors.length === 0) return;

  const configurations = getConfiguration();
  if (!Array.isArray(configurations) || configurations.length === 0) return;

  todoEditors.forEach((editor) => {
    const document = editor.document;

    const applicableRules = getAllApplicableRules(
      configurations,
      document.fileName
    );

    if (applicableRules.length === 0) return;

    callback(editor, applicableRules);
  });
};

const updateDecorations = () => {
  refreshDecorationConfig();

  if (documentDecorations.size === 0) return;

  const startTime = performance.now();

  forEachVisibleApplicableEditor((editor, applicableRules) => {
    const document = editor.document;

    const { allPatternDecorations, decoratedRangeGroups } =
      documentDecorations.get(document.uri)!;

    // Apply decorations.
    const decorationRanges: Map<
      vscode.TextEditorDecorationType,
      vscode.Range[]
    > = new Map();

    // Clear decoration ranges used for the hover provider;
    decoratedRangeGroups.clear();

    for (const rule of applicableRules) {
      const patterns = [rule.patterns ?? []].flat();
      const exhaustive = rule.exhaustive ?? false;

      for (const pattern of patterns) {
        const decorationGroups = allPatternDecorations.get(pattern);
        const patternRegex = regexes.get(pattern);

        if (!patternRegex || !decorationGroups) {
          continue;
        }

        if (rule.lines) {
          for (const line of rule.lines) {
            if (Array.isArray(line)) {
              const startLine = Math.max(line[0] - 1, 0);
              const endLine = Math.min(line[1], document.lineCount);

              for (
                let lineNumber = startLine;
                lineNumber < endLine;
                lineNumber++
              ) {
                decorateLine(
                  document,
                  lineNumber,
                  patternRegex,
                  decorationGroups,
                  decoratedRangeGroups,
                  decorationRanges,
                  exhaustive
                );
              }
            } else if (typeof line === "object") {
              const linePatternRegex = createRegex(
                line.pattern,
                rule.matchCase
              );

              if (!linePatternRegex) continue;

              for (
                let lineIndex = 0;
                lineIndex < document.lineCount;
                lineIndex++
              ) {
                const lineText = document.lineAt(lineIndex).text;

                if (linePatternRegex.test(lineText)) {
                  decorateLine(
                    document,
                    lineIndex,
                    patternRegex,
                    decorationGroups,
                    decoratedRangeGroups,
                    decorationRanges,
                    exhaustive
                  );
                }
              }
            } else {
              // single line
              decorateLine(
                document,
                line - 1,
                patternRegex,
                decorationGroups,
                decoratedRangeGroups,
                decorationRanges,
                exhaustive
              );
            }
          }
          continue;
        } else {
          for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
            decorateLine(
              document,
              lineIndex,
              patternRegex,
              decorationGroups,
              decoratedRangeGroups,
              decorationRanges,
              exhaustive
            );
          }
        }
      }
    }

    if (decorationRanges.size === 0) return;

    for (const [decorationType, ranges] of decorationRanges) {
      editor.setDecorations(decorationType, ranges);
    }

    const elapsedTime = performance.now() - startTime;

    logger.trace(
      `Decorated ${decorationRanges.size} ranges in ${elapsedTime.toFixed(
        2
      )}ms.`
    );
  });
};

const decorateLine = (
  document: vscode.TextDocument,
  lineIndex: number,
  patternRegex: RegExp,
  decorationGroups: Map<
    string | number,
    [DecorationOptions, vscode.TextEditorDecorationType]
  >,
  decoratedRangeGroups: Map<vscode.Range, [string | number, DecorationOptions]>,
  decorationRanges: Map<vscode.TextEditorDecorationType, vscode.Range[]>,
  exhaustive: boolean
) => {
  const lineText = document.lineAt(lineIndex).text;

  // For the exhaustive search, we track the last capture group offset.
  let unexamined = lineText.length;
  do {
    unexamined = tryMatchAndAddDecorationRange(
      lineText.slice(0, unexamined),
      patternRegex,
      decorationGroups,
      decoratedRangeGroups,
      decorationRanges,
      lineIndex
    );
  } while (exhaustive && unexamined > 0);
};

const tryMatchAndAddDecorationRange = (
  input: string,
  pattern: RegExp,
  decorationGroups: Map<
    string | number,
    [DecorationOptions, vscode.TextEditorDecorationType]
  >,
  decoratedRangeGroups: Map<vscode.Range, [string | number, DecorationOptions]>,
  decorationRanges: Map<vscode.TextEditorDecorationType, vscode.Range[]>,
  lineNumber: number
): number => {
  // For the exhaustive search, we will track the offset of the last matched capture group.
  // We slice the input text to the last matched capture group to avoid matching the same text again.
  let maxGroupOffset = -1; // sentinel value for no matches.

  for (const match of input.matchAll(pattern)) {
    if (match.index === undefined || !match.indices || match[0].length === 0) {
      continue;
    }

    for (const [
      targetCaptureGroup,
      [decorationOptions, decorationType],
    ] of decorationGroups) {
      const range =
        typeof targetCaptureGroup === "number"
          ? match.indices[targetCaptureGroup]
          : match.indices.groups![targetCaptureGroup];

      if (!range) continue;

      const start = range[0];
      const end = range[1];

      // Track the maximum starting offset of the capture groups.
      maxGroupOffset = Math.max(maxGroupOffset, start);

      const decorationRange = new vscode.Range(
        lineNumber,
        start,
        lineNumber,
        end
      );

      decoratedRangeGroups.set(decorationRange, [
        targetCaptureGroup,
        decorationOptions,
      ]);

      // Mark range to be decorated.
      if (decorationRanges.has(decorationType)) {
        decorationRanges.get(decorationType)!.push(decorationRange);
      } else {
        decorationRanges.set(decorationType, [decorationRange]);
      }
    }
  }
  return maxGroupOffset;
};

const refreshDecorationConfig = () => {
  logger.debug("Refreshing document decorations...");

  const startTime = performance.now();

  sharedDecorations = new Map<string, DecorationOptions>(
    Object.entries(getSharedDecorations() ?? {})
  );

  forEachVisibleApplicableEditor((editor, applicableRules) => {
    const document = editor.document;

    // Clear all decorations.
    let documentDecoration = documentDecorations.get(document.uri);
    if (!documentDecoration) {
      documentDecoration = {
        allPatternDecorations: new Map(),
        decoratedRangeGroups: new Map(),
      };
      documentDecorations.set(document.uri, documentDecoration);
    }

    for (const decorationType of documentDecoration.allPatternDecorations?.values()) {
      for (const [, decoration] of decorationType.values()) {
        decoration.dispose();
      }
    }

    // Refresh decoration-type map.
    documentDecoration.allPatternDecorations = new Map();

    for (const rule of applicableRules) {
      if (!rule.patterns || rule.decorations === undefined) return;

      const patterns = [rule.patterns].flat();

      const decorations = [rule.decorations]
        .flat()
        .map((decoration) =>
          typeof decoration == "string"
            ? sharedDecorations.get(decoration)
            : decoration
        )
        .filter(Boolean) as DecorationOptions[];

      for (const pattern of patterns) {
        createRegex(pattern, rule.matchCase);

        createDecorationGroups(
          pattern,
          decorations,
          documentDecoration.allPatternDecorations
        );
      }
    }

    const elapsedTime = performance.now() - startTime;

    logger.trace(`Refreshed all patterns in ${elapsedTime.toFixed(2)}ms.`);
  });
};

const createRegex = (pattern: string, matchCase?: boolean) => {
  let regex = regexes.get(pattern);
  if (regex) {
    return regex;
  }

  let flags = "dg";
  if (!matchCase) flags += "i";

  try {
    regex = new RegExp(pattern, flags);
    regexes.set(pattern, regex);
    return regex;
  } catch (e) {
    logger.error(`Failed to create regex for pattern "${pattern}".`, e);
    return null;
  }
};

const createDecorationGroups = (
  pattern: string,
  decorations: readonly DecorationOptions[],
  patternDecorations: Map<
    // pattern
    string,
    DecorationGroup
  >
) => {
  if (!patternDecorations.has(pattern)) {
    patternDecorations.set(pattern, new Map());
  }

  const patternDecoration = patternDecorations.get(pattern);

  for (const decoration of decorations) {
    // if no groups are specified, default to capture group 0, i.e. the entire match.
    const groups = [decoration.groups ? decoration.groups : 0].flat();

    const decorationType =
      vscode.window.createTextEditorDecorationType(decoration);

    for (const group of groups) {
      patternDecoration!.set(group, [decoration, decorationType]);
    }
  }
};

const matchFileNameToPathPattern = (
  filename: string,
  pattern: string
): boolean => {
  if (typeof pattern !== "string") return false;

  // Support matches by filenames and relative file paths.
  const patternToMatch =
    pattern.includes("/") || pattern.includes("\\") ? pattern : "**/" + pattern;

  return minimatch(vscode.workspace.asRelativePath(filename), patternToMatch);
};

const getAllApplicableRules = (
  configurations: Configuration[],
  path: string
): Rule[] =>
  configurations
    .filter(
      (configuration) =>
        Array.isArray(configuration.paths) &&
        configuration.paths.some((pattern) =>
          matchFileNameToPathPattern(path, pattern)
        )
    )
    .flatMap((configuration) => configuration.rules ?? []);
