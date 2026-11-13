import { z } from "zod";
import type { AppService } from "../apps/service.js";
import { slug } from "../apps/tools.js";
import type { ToolDefinition } from "../tool-runtime.js";

/**
 * App tasks for a person's assistant. These are MCP only: an agent that runs
 * inside an app's task has no use for starting more, so they are never added
 * to the agent tool declarations (`APP_TOOL_DEFINITIONS`).
 */
const template = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const taskId = z.string().min(1);

export const MCP_TASK_DEFINITIONS: ToolDefinition<AppService>[] = [
  {
    name: "apps_task_list",
    displayName: "List app tasks",
    description: "List the tasks an app has started, optionally for one template or row: each task's status and link.",
    schema: z.object({ app: slug, template: template.optional(), rowId: z.string().min(1).optional() }),
    run: (s, c, a, p) => s.runtimeTaskList(c, a, p.app, { template: p.template, rowId: p.rowId }),
  },
  {
    name: "apps_task_get",
    displayName: "Check app task",
    description: "Check one task an app started: its status and, once the agent has finished, its reply.",
    schema: z.object({ app: slug, taskId }),
    run: (s, c, a, p) => s.runtimeTaskGet(c, a, p.app, p.taskId),
  },
  {
    name: "apps_task_start",
    displayName: "Start app task",
    description: "Start one of an app's task templates for the person, as pressing the app's button would: the template's agent gets a task with the row's declared fields and the inputs. The app's templates are under tasks in its manifest (apps_get); every input a template declares is required.",
    schema: z.object({ app: slug, template, rowId: z.string().min(1).optional(), inputs: z.record(z.string(), z.union([z.string(), z.number()])).optional() }),
    run: (s, c, a, p) => s.runtimeTaskStart(c, a, p.app, p.template, { rowId: p.rowId, inputs: p.inputs }),
  },
  {
    name: "apps_task_cancel",
    displayName: "Cancel app task",
    description: "Cancel a task an app started. A run the agent already began may finish its current step.",
    schema: z.object({ app: slug, taskId }),
    run: (s, c, a, p) => s.runtimeTaskCancel(c, a, p.app, p.taskId),
  },
];
