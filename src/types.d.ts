import * as vscode from "vscode";

export type Configuration = {
  paths?: string[];
  rules?: Rule[];
};

export type RulePattern = string[] | string;

export type Rule = {
  patterns?: RulePattern;
  decorations?: DecorationOptions | DecorationOptions[];
  matchCase?: boolean;
  exhaustive?: boolean;
};

export type DecorationOptions = {
  groups?: (string | number)[];
  description?: string;
} & vscode.DecorationRenderOptions;
