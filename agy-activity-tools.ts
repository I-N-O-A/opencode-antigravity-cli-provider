const ACTIVITY_TOOLS = [
  ["agy_shell", "AGY Shell"],
  ["agy_read", "AGY Read"],
  ["agy_write", "AGY Write"],
  ["agy_edit", "AGY Edit"],
  ["agy_grep", "AGY Grep"],
  ["agy_find", "AGY Find"],
  ["agy_task", "AGY Task"],
  ["agy_question", "AGY Question"],
  ["agy_web_search", "AGY Web Search"],
  ["agy_web_fetch", "AGY Web Fetch"],
  ["agy_activity", "AGY Activity"],
] as const

function readable(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default {
  id: "agy-activity-tools",
  async setup(ctx: any) {
    await ctx.tool.transform((tools: any) => {
      for (const [name, label] of ACTIVITY_TOOLS) {
        tools.add({
          name,
          description: `Display one action already performed by the AGY CLI as a native OpenCode tool card. This is display-only and must never execute or repeat the action. ${label}.`,
          input: {
            type: "object",
            properties: {
              tool: { type: "string" },
              status: { type: "string" },
              parameters: {},
              output: {},
              error: {},
            },
            required: ["tool", "status", "parameters"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (activity: any) => ({
            content: [
              `${label} · ${activity.status}`,
              "Action:",
              readable(activity.parameters),
              ...(activity.output !== undefined ? ["Output:", readable(activity.output)] : []),
              ...(activity.error !== undefined ? ["Error:", readable(activity.error)] : []),
            ].join("\n\n"),
          }),
        })
      }
    })
  },
}
