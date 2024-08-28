import { minimatch } from "minimatch";
import * as vscode from "vscode";

import type { Configuration, DecorationOptions, Rule } from "./types";

const extensionConfigurationName = "colorMyTextExtended";
const extensionName = "Color My Text Extended";

let logger = vscode.window.createOutputChannel(extensionName, {
  log: true,
});

// TODO: Group the decorations to be isolated per applicable documents.

// Cached regexes
const regexes = new Map<string, RegExp>();

// decoration capture group -> decoration options
type DecorationOptionsGroup = Map<string | number, DecorationOptions>;

// decoration capture group -> decoration options
type DecorationGroup = Map<string | number, vscode.TextEditorDecorationType>;

// rule pattern -> DecorationOptionsGroup
let captureGroupDecorations: Map<string, DecorationOptionsGroup> = new Map();

// rule pattern -> DecorationGroup
let allPatternDecorations: Map<string, DecorationGroup> = new Map();

// decoration range -> matched capture group & decoration options.
let decoratedRangeGroups = new Map<
  vscode.Range,
  [string | number, DecorationOptions]
>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    logger,

    vscode.window.onDidChangeVisibleTextEditors(updateDecorations),

    vscode.workspace.onDidChangeConfiguration(handleConfigurationChange),
    vscode.workspace.onDidSaveTextDocument(updateDecorations), // TODO: make decoration updates more targeted per the paths in the configuration.

    vscode.languages.registerHoverProvider("plaintext", {
      provideHover: decoratedGroupHoverProvider,
    })
  );

  refreshDecorations();
  updateDecorations();

  logger.info(`Extension "${extensionConfigurationName}" activated!`);
}

const handleConfigurationChange = (event: vscode.ConfigurationChangeEvent) => {
  if (
    event.affectsConfiguration(extensionConfigurationName + ".configurations")
  ) {
    refreshDecorations();
    updateDecorations();
  }
};

const decoratedGroupHoverProvider = (
  _document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): vscode.Hover | undefined => {
  // TODO: the ranges should be document specific.. lol
  // Consider using interval tree. This _very_ inefficient.
  for (const [range, [group, decoration]] of decoratedRangeGroups) {
    if (token.isCancellationRequested) return;
    if (!range.contains(position)) continue;

    const hoverLines = [
      `Group: \`${group}\``,
      decoration.description && `Description: ${decoration.description}`,
    ];

    return new vscode.Hover(
      hoverLines.filter(Boolean).map((line) => new vscode.MarkdownString(line)),
      range
    );
  }
};

const createRegex = (
  pattern: string | RegExp,
  multiline: boolean,
  matchCase?: boolean
) => {
  let flags = "dg";
  if (multiline) flags += "m";
  if (!matchCase) flags += "i";

  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    logger.error(`Failed to create regex for pattern "${pattern}".`, e);
  }
};

const getConfiguration = () => {
  return vscode.workspace
    .getConfiguration(extensionConfigurationName)
    .get<Configuration[]>("configurations");
};

function updateDecorations(): void {
  if (allPatternDecorations.size === 0) return;

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

    // Apply decorations.
    const decorationRanges: Map<
      vscode.TextEditorDecorationType,
      vscode.Range[]
    > = new Map();

    // Clear decoration ranges used for the hover provider;
    decoratedRangeGroups.clear();

    const documentText = document.getText();

    for (const rule of applicableRules) {
      const patterns = [rule.patterns ?? []].flat();

      for (const pattern of patterns) {
        const decorationGroups = allPatternDecorations.get(pattern);
        const decorationOptionGroups = captureGroupDecorations.get(pattern);
        const patternRegex = regexes.get(pattern);

        if (!patternRegex || !decorationGroups || !decorationOptionGroups) {
          continue;
        }

        if (!rule.exhaustive) {
          tryMatchAndAddDecorationRange(
            document,
            documentText,
            patternRegex,
            decorationGroups,
            decorationOptionGroups,
            decoratedRangeGroups,
            decorationRanges
          );
        } else {
          for (
            let lineNumber = 0;
            lineNumber < document.lineCount;
            lineNumber++
          ) {
            const lineText = document.lineAt(lineNumber).text;

            let index = lineText.length;
            do {
              index = tryMatchAndAddDecorationRange(
                document,
                lineText.slice(0, index),
                patternRegex,
                decorationGroups,
                decorationOptionGroups,
                decoratedRangeGroups,
                decorationRanges,
                lineNumber
              );
            } while (index > 0);
          }
        }
      }
    }

    if (decorationRanges.size === 0) return;

    for (const [decorationType, ranges] of decorationRanges) {
      editor.setDecorations(decorationType, ranges);
    }
  });
}

const tryMatchAndAddDecorationRange = (
  document: vscode.TextDocument,
  input: string,
  pattern: RegExp,
  decorationGroups: DecorationGroup,
  decorationOptionGroups: DecorationOptionsGroup,
  decoratedRangeGroups: Map<vscode.Range, [string | number, DecorationOptions]>,
  decorationRanges: Map<vscode.TextEditorDecorationType, vscode.Range[]>,
  lineNumber?: number
): number => {
  let minimumMatchIndex = -1;
  for (const match of input.matchAll(pattern)) {
    if (match.index === undefined || !match.indices || match[0].length === 0) {
      continue;
    }

    for (const [targetCaptureGroup, decorationType] of decorationGroups) {
      const range =
        typeof targetCaptureGroup === "number"
          ? match.indices[targetCaptureGroup]
          : match.indices.groups![targetCaptureGroup];

      if (!range) continue;

      const start = range[0];
      const end = range[1];

      // todo: think about this again
      if (minimumMatchIndex === -1) minimumMatchIndex = start;
      else minimumMatchIndex = Math.min(minimumMatchIndex, end);

      const decorationRange = lineNumber
        ? new vscode.Range(lineNumber, start, lineNumber, end)
        : new vscode.Range(
            document.positionAt(start),
            document.positionAt(end)
          );

      const decorationOptions = decorationOptionGroups.get(targetCaptureGroup)!;

      // Mark range to be decorated.
      decoratedRangeGroups.set(decorationRange, [
        targetCaptureGroup,
        decorationOptions,
      ]);

      if (decorationRanges.has(decorationType)) {
        decorationRanges.get(decorationType)!.push(decorationRange);
      } else {
        decorationRanges.set(decorationType, [decorationRange]);
      }
    }
  }
  return minimumMatchIndex;
};

const refreshDecorations = () => {
  logger.info("Refreshing document decorations...");

  // Clear all decorations.
  for (const decorationGroup of allPatternDecorations.values()) {
    for (const decorationType of decorationGroup.values()) {
      decorationType.dispose();
    }
  }

  // Refresh decoration-type map.
  const configurations = getConfiguration();
  if (!Array.isArray(configurations)) return;

  allPatternDecorations = new Map();

  for (const configuration of configurations) {
    if (!Array.isArray(configuration.rules)) return;

    for (const rule of configuration.rules) {
      if (!rule.patterns || rule.decorations === undefined) return;

      const patterns = [rule.patterns].flat();
      const decorations = [rule.decorations].flat();

      for (const pattern of patterns) {
        if (typeof pattern !== "string") return;

        if (!regexes.has(pattern)) {
          regexes.set(
            pattern,
            createRegex(pattern, !rule.exhaustive ?? true, rule.matchCase)!
          );
        }

        createDecorationGroups(
          pattern,
          decorations,
          allPatternDecorations,
          captureGroupDecorations
        );
      }
    }
  }
};

const createDecorationGroups = (
  pattern: string,
  decorations: readonly DecorationOptions[],
  patternDecorations: Map<string, DecorationGroup>,
  captureGroupDecorations: Map<string, DecorationOptionsGroup>
) => {
  if (!patternDecorations.has(pattern)) {
    patternDecorations.set(pattern, new Map());
  }

  if (!captureGroupDecorations.has(pattern)) {
    captureGroupDecorations.set(pattern, new Map());
  }

  const patternDecoration = patternDecorations.get(pattern);
  const captureGroupDecoration = captureGroupDecorations.get(pattern);

  for (const decoration of decorations) {
    // if no groups are specified, default to capture group 0, i.e. the entire match.
    const decorationGroups = [decoration.groups ? decoration.groups : 0].flat();

    const decorationType =
      vscode.window.createTextEditorDecorationType(decoration);

    for (const group of decorationGroups) {
      patternDecoration!.set(group, decorationType);
      captureGroupDecoration!.set(group, decoration);
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
