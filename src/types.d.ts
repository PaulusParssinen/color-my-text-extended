import * as vscode from "vscode";

export type Configuration = {
  paths?: string[];
  rules?: Rule[];
};

export type RulePattern = string[] | string;

export type LineSelector = {
  pattern: string;
};

export type Rule = {
  patterns?: RulePattern;
  decorations?: string | string[] | DecorationOptions[];
  matchCase?: boolean;
  exhaustive?: boolean;
  // array member can either single line or a line range
  lines?: (number | [number, number] | LineSelector)[];
};

export type DecorationOptions = {
  groups?: (string | number)[];
  description?: string;
} & vscode.DecorationRenderOptions;

export type DecorationGroup = Map<
  // capture group
  string | number,
  [DecorationOptions, vscode.TextEditorDecorationType]
>;

export type DocumentDecorations = {
  allPatternDecorations: Map<
    // pattern
    string,
    DecorationGroup
  >;
  // decoration capture group -> decoration options
  decoratedRangeGroups: Map<vscode.Range, [string | number, DecorationOptions]>;
};
