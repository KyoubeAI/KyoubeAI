import type { Tint } from "../characters.js";

export type OrgState = "working" | "waiting" | "attention" | "paused" | "idle";

export interface OrgTask { id: string; identifier: string; title: string; href: string }

export interface OrgAgent {
  id: string;
  name: string;
  title: string | null;
  icon: string | null;
  state: OrgState;
  detail: string;
  task: OrgTask | null;
  reportsTo: string | null;
  href?: string;
}

export interface OrgNode { agent: OrgAgent; children: OrgNode[] }

export interface OrgTally { agents: number; working: number; waiting: number; attention: number; paused: number }

export interface OrgPanel {
  id: string;
  kind: "team" | "office";
  owner: OrgAgent;
  name: string;
  tint: Tint;
  members: OrgNode[];
  tally: OrgTally;
  attention: boolean;
}

export interface OrgHead { agent: OrgAgent; panels: OrgPanel[] }

export interface OrgTree {
  heads: OrgHead[];
  teams: OrgPanel[];
  shelf: OrgAgent[];
  managerOf: Map<string, string | null>;
  reportsOf: Map<string, string[]>;
  byId: Map<string, OrgAgent>;
}
