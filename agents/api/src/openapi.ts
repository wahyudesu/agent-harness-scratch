export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Minimal Agent API",
    version: "1.0.0",
    description:
      "Hono API wrapper around the agent harness. Runs a guardrailed LLM loop with tool backends (local Chromium via Playwright, or Exa web API) and optional verify/retry.",
  },
  tags: [
    { name: "Agent", description: "Model catalog, toolbackends, and run lifecycle" },
    { name: "Health", description: "Liveness probe" },
    { name: "Docs", description: "Machine-readable API schema" },
  ],
  paths: {
    "/api/models": {
      get: {
        tags: ["Agent"],
        summary: "List model catalogue",
        description: "Returns the default model and the full catalogue clients build their model pickers from.",
        operationId: "getModels",
        responses: {
          "200": {
            description: "Model catalogue",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ModelsResponse" },
                example: {
                  default: "openai/gpt-oss-20b",
                  models: [
                    {
                      id: "openai/gpt-oss-20b",
                      name: "gpt-oss-20b",
                      provider: "Groq",
                      context: 131072,
                      efforts: ["low", "medium", "high"],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/api/tools": {
      get: {
        tags: ["Agent"],
        summary: "List tools for a backend",
        description: "Returns available tool providers and the tool definitions for one backend. Statis — does not launch Chromium.",
        operationId: "getTools",
        parameters: [
          {
            name: "provider",
            in: "query",
            required: false,
            description: "Tool backend. Defaults to `chromium`.",
            schema: { type: "string", enum: ["chromium", "exa"], default: "chromium" },
          },
        ],
        responses: {
          "200": {
            description: "Tool list for the requested backend",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ToolsResponse" },
              },
            },
          },
          "400": {
            description: "Unknown tool provider",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/run": {
      post: {
        tags: ["Agent"],
        summary: "Run the agent harness on a task",
        description:
          "Guardrailed loop + optional verify/retry. Each attempt opens a fresh browser session. " +
          "Send `accept: text/event-stream` to receive SSE progress events (`iteration`, `tool_call`, `tool_result`, `answer_delta`, `done`, `error`) and stream tokens live; otherwise the full JSON response is returned only once the run finishes.",
        operationId: "runTask",
        parameters: [
          {
            name: "Accept",
            in: "header",
            required: false,
            description: "Set to `text/event-stream` for SSE streaming.",
            schema: { type: "string", example: "text/event-stream" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunRequest" },
              example: {
                task: "Go to https://news.ycombinator.com and list the top 3 story titles.",
                model: "openai/gpt-oss-20b",
                effort: "medium",
                tools: "chromium",
                maxIterations: 15,
                maxAttempts: 1,
                verify: false,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Run result (JSON mode) or SSE stream (when `accept: text/event-stream`)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RunResponse" },
              },
              "text/event-stream": {
                description: "Server-sent events",
                schema: { type: "string" },
              },
            },
          },
          "400": {
            description: "Validation error, unknown model, unsupported effort, or Exa key missing",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "499": {
            description: "Run aborted by the client",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "500": {
            description: "Browser or model failure",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/runs/{id}": {
      delete: {
        tags: ["Agent"],
        summary: "Abort an in-flight run",
        operationId: "deleteRun",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "The `runId` returned by `POST /api/run`.",
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Run aborted",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OkResponse" },
              },
            },
          },
          "404": {
            description: "Run not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        description: "Used by Docker `HEALTHCHECK`. Reports whether the model and Exa keys are configured (booleans only).",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Health status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ModelInfo: {
        type: "object",
        required: ["id", "name", "provider", "context", "efforts"],
        properties: {
          id: { type: "string", example: "openai/gpt-oss-20b" },
          name: { type: "string", example: "gpt-oss-20b" },
          provider: { type: "string", example: "Groq" },
          context: { type: "integer", example: 131072, description: "Provider context window in tokens." },
          efforts: {
            type: "array",
            items: { type: "string", enum: ["low", "medium", "high"] },
            example: ["low", "medium", "high"],
          },
        },
      },
      ModelsResponse: {
        type: "object",
        required: ["default", "models"],
        properties: {
          default: { type: "string", example: "openai/gpt-oss-20b" },
          models: { type: "array", items: { $ref: "#/components/schemas/ModelInfo" } },
        },
      },
      ToolsResponse: {
        type: "object",
        required: ["providers", "exaConfigured", "provider", "tools"],
        properties: {
          providers: { type: "array", items: { type: "string", enum: ["chromium", "exa"] } },
          exaConfigured: { type: "boolean", example: false },
          provider: { type: "string", enum: ["chromium", "exa"], example: "chromium" },
          tools: {
            type: "array",
            items: { $ref: "#/components/schemas/ToolDefinition" },
          },
        },
      },
      ToolDefinition: {
        type: "object",
        required: ["type", "function"],
        properties: {
          type: { type: "string", example: "function" },
          function: {
            type: "object",
            required: ["name", "description", "parameters"],
            properties: {
              name: { type: "string", example: "browser_navigate" },
              description: { type: "string", example: "Navigate the browser to a URL." },
              parameters: { type: "object", additionalProperties: true },
            },
          },
        },
      },
      RunRequest: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", minLength: 1, example: "Get the current URL after navigating to https://example.com" },
          model: {
            type: "string",
            default: "openai/gpt-oss-20b",
            description: "Provider model id from `GET /api/models`.",
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Reasoning effort for models that support it.",
          },
          systemPrompt: {
            type: "string",
            description: "Optional system prompt overriding the harness default.",
          },
          tools: {
            type: "string",
            enum: ["chromium", "exa"],
            default: "chromium",
            description: "`chromium` (local Playwright) or `exa` (Exa web API, needs `EXA_API_KEY`).",
          },
          maxIterations: {
            type: "integer",
            minimum: 1,
            default: 15,
            description: "Cap on agent loop iterations per attempt before the guardrail stops it.",
          },
          maxAttempts: {
            type: "integer",
            minimum: 1,
            default: 1,
            description: "Retry the whole run this many attempts when verify fails.",
          },
          verify: {
            type: "boolean",
            default: false,
            description: "Built-in verify: require at least one successful tool call before trusting the answer.",
          },
        },
      },
      ToolEvent: {
        type: "object",
        required: ["tool", "args", "result"],
        properties: {
          tool: { type: "string", example: "browser_navigate" },
          args: { type: "object", additionalProperties: true },
          result: { type: "string", example: "Navigated to https://example.com" },
        },
      },
      LoopIteration: {
        type: "object",
        required: ["index", "outcome", "toolEvents", "contextSize", "contextTrimmed"],
        properties: {
          index: { type: "integer", example: 1 },
          outcome: { type: "string", enum: ["tool_calls", "answer"] },
          toolEvents: { type: "array", items: { $ref: "#/components/schemas/ToolEvent" } },
          contextSize: { type: "integer", example: 3 },
          contextTrimmed: { type: "boolean", example: false },
        },
      },
      VerifyResult: {
        type: "object",
        required: ["passed", "reason"],
        properties: {
          passed: { type: "boolean" },
          reason: { type: "string" },
          fatal: { type: "boolean", description: "If true, don't retry — the task cannot succeed." },
        },
      },
      RunResponse: {
        type: "object",
        required: ["runId", "task", "model", "answer", "iterations", "trace", "stoppedBy", "attempts"],
        properties: {
          runId: { type: "string", format: "uuid" },
          task: { type: "string" },
          model: { type: "string" },
          answer: { type: "string" },
          iterations: { type: "integer" },
          trace: { type: "array", items: { $ref: "#/components/schemas/LoopIteration" } },
          stoppedBy: { type: "string", enum: ["model", "guardrail", "success"] },
          attempts: { type: "integer" },
          verification: { $ref: "#/components/schemas/VerifyResult", nullable: true },
        },
      },
      OkResponse: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      },
      HealthResponse: {
        type: "object",
        required: ["ok", "modelKey", "exaKey"],
        properties: {
          ok: { type: "boolean", example: true },
          modelKey: { type: "boolean", example: true },
          exaKey: { type: "boolean", example: false },
        },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "object", additionalProperties: true } },
            ],
          },
          runId: { type: "string", format: "uuid" },
        },
      },
    },
  },
} as const;
