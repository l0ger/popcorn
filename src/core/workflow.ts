import { parse } from "yaml";
import { Ajv } from "ajv";
import type { Phase, Workflow } from "./types.js";

const stringList = { type: "array", items: { type: "string", minLength: 1 } } as const;

/** JSON Schema of .popcorn/workflow.yaml. Semantic checks (references between phases) follow below. */
export const WORKFLOW_SCHEMA = {
  type: "object",
  required: ["version", "name", "phases"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        deny_shell: stringList,
        guarded_shell: stringList,
        guarded_mcp: stringList,
        protect_paths: stringList,
        max_attempts_per_phase: { type: "integer", minimum: 1, maximum: 7 },
        blocking_severities: stringList,
        blocking_verdicts: stringList,
        gate_timeout_seconds: { type: "integer", minimum: 1 },
      },
    },
    phases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "goal"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,39}$" },
          title: { type: "string" },
          goal: { type: "string", minLength: 1 },
          instructions: { type: "string" },
          agent: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
          artifacts: stringList,
          outputs: {
            type: "object",
            required: ["schema", "required"],
            additionalProperties: false,
            properties: { schema: { type: "string" }, required: { ...stringList, minItems: 1 } },
          },
          gates: stringList,
          approval: { enum: ["none", "before", "after"] },
          allow: {
            type: "object",
            additionalProperties: false,
            properties: { edit: stringList, shell: stringList, mcp: stringList, guarded: stringList },
          },
          deny: {
            type: "object",
            additionalProperties: false,
            properties: { edit: stringList, shell: stringList },
          },
          unlock_after: { type: "string" },
          on_fail: { type: "string" },
          next: { type: "string" },
        },
      },
    },
    schemas: { type: "object", additionalProperties: { type: "object" } },
  },
} as const;

export class WorkflowError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid workflow:\n- ${problems.join("\n- ")}`);
    this.name = "WorkflowError";
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(WORKFLOW_SCHEMA);

/** Parses and validates a workflow. Throws WorkflowError listing every problem found. */
export function parseWorkflow(text: string): Workflow {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new WorkflowError([`YAML: ${(e as Error).message.split("\n")[0]}`]);
  }
  if (!validateShape(data)) {
    throw new WorkflowError((validateShape.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`));
  }
  const wf = data as Workflow;
  const problems = semanticProblems(wf);
  if (problems.length) throw new WorkflowError(problems);
  return wf;
}

function semanticProblems(wf: Workflow): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of wf.phases) {
    if (ids.has(p.id)) problems.push(`phase "${p.id}" is defined twice`);
    ids.add(p.id);
  }
  for (const p of wf.phases) {
    for (const [field, ref] of [["next", p.next], ["on_fail", p.on_fail], ["unlock_after", p.unlock_after]] as const) {
      if (ref !== undefined && !ids.has(ref)) problems.push(`phase "${p.id}": ${field} "${ref}" is not a phase`);
    }
    if (p.outputs) {
      if (!wf.schemas?.[p.outputs.schema]) problems.push(`phase "${p.id}": outputs.schema "${p.outputs.schema}" is not in schemas`);
      else {
        try { ajv.compile(wf.schemas[p.outputs.schema]!); }
        catch (e) { problems.push(`schema "${p.outputs.schema}": ${(e as Error).message}`); }
      }
      if (p.on_fail === undefined) problems.push(`phase "${p.id}": outputs need on_fail (where to go on a blocking finding)`);
    }
    const guarded = [...(wf.policy?.guarded_shell ?? []), ...(wf.policy?.guarded_mcp ?? [])];
    for (const g of p.allow?.guarded ?? []) {
      if (!guarded.includes(g)) problems.push(`phase "${p.id}": allow.guarded "${g}" is not in policy.guarded_shell or policy.guarded_mcp`);
    }
    if (p.allow?.guarded?.length && p.approval !== "before" && p.unlock_after === undefined) {
      problems.push(`phase "${p.id}": allow.guarded needs approval: before (the user unlocks it) or unlock_after (an earlier phase's pass unlocks it)`);
    }
    if (p.unlock_after !== undefined && ids.has(p.unlock_after)) {
      const at = wf.phases.findIndex(x => x.id === p.unlock_after);
      if (at >= wf.phases.indexOf(p)) problems.push(`phase "${p.id}": unlock_after "${p.unlock_after}" must be an earlier phase`);
    }
  }
  return problems;
}

/** Validates one agent output against a named schema. Returns the problems (empty = valid). */
export function outputProblems(wf: Workflow, schema: string, data: unknown): string[] {
  const validate = ajv.compile(wf.schemas?.[schema] ?? {});
  if (validate(data)) return [];
  return (validate.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}

export function phaseById(wf: Workflow, id: string): Phase {
  const p = wf.phases.find(x => x.id === id);
  if (!p) throw new WorkflowError([`phase "${id}" is not in workflow "${wf.name}"`]);
  return p;
}

/** The phase after `p`: its `next`, else the following one in the list, else none (the run is done). */
export function nextPhase(wf: Workflow, p: Phase): Phase | undefined {
  if (p.next) return phaseById(wf, p.next);
  return wf.phases[wf.phases.indexOf(p) + 1];
}

/** Substitutes {task} and {phase} in a path or text. */
export function fill(text: string, vars: { task: string; phase?: string; round?: number }): string {
  return text
    .replace(/\{task\}/g, vars.task)
    .replace(/\{phase\}/g, vars.phase ?? "")
    .replace(/\{round\}/g, String(vars.round ?? 1));
}
