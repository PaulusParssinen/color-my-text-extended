import { minimatch } from "minimatch";
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  console.log('Extension "color-my-text-extended" is activated.');

  type Configuration = {
    paths?: string[];
    rules?: Rule[];
  };

  type DecorationOptions = {
    groups?: (string | number)[];
  } & vscode.DecorationRenderOptions;

  type Rule = {
    patterns?: string[] | string;
    decorations?: DecorationOptions[];
    matchCase?: boolean;
  };

  let todoEditors: vscode.TextEditor[];
  let doneEditors: vscode.TextEditor[];

  // Cached regexes
  const regexes = new Map<string, RegExp>();

  // Maps rule pattern -> (decoration capture group -> decoration type).
  let allPatternDecorations: Map<
    string,
    Map<string | number, vscode.TextEditorDecorationType>
  > = new Map();

  const createRegex = (pattern: string, matchCase?: boolean) => {
    if (typeof pattern !== "string") return;

    try {
      return new RegExp(pattern, matchCase ? "dgu" : "dgiu");
    } catch (e) {
      return;
    }
  };

  const getConfiguration = () => {
    return vscode.workspace
      .getConfiguration("colorMyTextExtended")
      .get<Configuration[]>("configurations");
  };

  const resetDecorations = () => {
    todoEditors = vscode.window.visibleTextEditors.slice();
    doneEditors = [];

    // Clear all decorations.
    todoEditors.forEach((todoEditor) =>
      allPatternDecorations.forEach((decorationGroup) =>
        decorationGroup.forEach((decorationType) =>
          todoEditor.setDecorations(decorationType, [])
        )
      )
    );

    // Refresh decoration-type map.
    const configurations = getConfiguration();
    if (!Array.isArray(configurations)) return;

    // Rebuild the decoration map
    allPatternDecorations = new Map();
    configurations.map((configuration) => {
      if (!Array.isArray(configuration.rules)) return [];

      const createDecorationGroups = (
        pattern: string,
        decorations: DecorationOptions[]
      ) => {
        if (!allPatternDecorations.has(pattern)) {
          allPatternDecorations.set(pattern, new Map());
        }

        decorations.forEach((decoration) => {
          const decorationType =
            vscode.window.createTextEditorDecorationType(decoration);

          // If no groups are specified, default to capture group at index 0, which matches everything.
          const decorationGroups =
            decoration.groups === undefined ? [0] : decoration.groups;

          decorationGroups.forEach((group) => {
            allPatternDecorations.get(pattern)!.set(group, decorationType);
          });
        });
      };

      configuration.rules.forEach((rule) => {
        if (rule.patterns === undefined || rule.decorations === undefined)
          return;

        const patterns = Array.isArray(rule.patterns)
          ? rule.patterns
          : [rule.patterns];

        patterns.forEach((pattern) => {
          if (typeof pattern !== "string") return;

          if (!regexes.has(pattern)) {
            regexes.set(pattern, createRegex(pattern, rule.matchCase)!);
          }

          createDecorationGroups(pattern, rule.decorations!);
        });
      });
      console.log(allPatternDecorations);
    });
  };

  function updateDecorations(): void {
    if (allPatternDecorations.size === 0) return;
    if (todoEditors.length === 0) return;

    const configurations = getConfiguration();
    if (!Array.isArray(configurations)) return;

    todoEditors.forEach((todoEditor) => {
      const applicableConfigurations = configurations.filter(
        (configuration) =>
          Array.isArray(configuration.paths) &&
          configuration.paths.some((path) => {
            if (typeof path !== "string") {
              return false;
            }

            // Support matches by filenames and relative file paths.
            const pattern =
              path.includes("/") || path.includes("\\") ? path : "**/" + path;
            return minimatch(
              vscode.workspace.asRelativePath(todoEditor.document.fileName),
              pattern
            );
          })
      );

      if (applicableConfigurations.length === 0) return;

      applicableConfigurations.forEach((configuration) => {
        const decorationRanges: Map<
          vscode.TextEditorDecorationType,
          vscode.Range[]
        > = new Map();

        const matchAndAddDecorationRange = (
          lineNumber: number,
          line: string,
          pattern: RegExp,
          decorationGroups: Map<
            string | number,
            vscode.TextEditorDecorationType
          >
        ) => {
          for (const match of line.matchAll(pattern)) {
            if (
              match.index === undefined ||
              match.indices === undefined ||
              match[0].length === 0
            ) {
              continue;
            }

            for (const group of decorationGroups.keys()) {
              const range =
                typeof group === "number"
                  ? match.indices[group]
                  : match.indices.groups![group];

              if (range === undefined) continue;

              const decorationRange = new vscode.Range(
                lineNumber,
                range[0],
                lineNumber,
                range[1]
              );

              const decorationType = decorationGroups.get(group)!;
              if (decorationRanges.has(decorationType)) {
                decorationRanges.get(decorationType)!.push(decorationRange);
              } else {
                decorationRanges.set(decorationType, [decorationRange]);
              }
            }
          }
        };

        for (
          let lineNumber = 0;
          lineNumber < todoEditor.document.lineCount;
          lineNumber++
        ) {
          const lineText = todoEditor.document.lineAt(lineNumber).text;

          for (const pattern of allPatternDecorations.keys()) {
            const decorationGroups = allPatternDecorations.get(pattern);
            const patternRegex = regexes.get(pattern);

            if (patternRegex === undefined || decorationGroups === undefined)
              continue;

            matchAndAddDecorationRange(
              lineNumber,
              lineText,
              patternRegex,
              decorationGroups
            );
          }
        }

        if (decorationRanges.size === 0) return;

        decorationRanges.forEach((ranges, decorationType) => {
          todoEditor.setDecorations(decorationType, ranges);
        });
      });

      doneEditors.push(todoEditor);
    });

    todoEditors = [];
  }

  vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (event.affectsConfiguration("colorMyTextExtended.configurations")) {
        resetDecorations();
      }
    },
    null,
    context.subscriptions
  );

  vscode.window.onDidChangeVisibleTextEditors(
    (visibleEditors) => {
      todoEditors = visibleEditors.filter(
        (visibleEditor) => !doneEditors.includes(visibleEditor)
      );
      doneEditors = doneEditors.filter((doneEditor) =>
        visibleEditors.includes(doneEditor)
      );
    },
    null,
    context.subscriptions
  );

  vscode.workspace.onDidChangeTextDocument(
    (event) => {
      vscode.window.visibleTextEditors.forEach((visibleEditor) => {
        if (
          visibleEditor.document === event.document &&
          !todoEditors.includes(visibleEditor)
        ) {
          todoEditors.push(visibleEditor);
        }
      });

      doneEditors = doneEditors.filter(
        (doneEditor) => !todoEditors.includes(doneEditor)
      );
    },
    null,
    context.subscriptions
  );

  resetDecorations();
  setInterval(updateDecorations, 500);
}
