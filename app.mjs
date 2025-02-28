import express from "express";
import { OpenAI } from "openai";
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from "path";

// Load environment variables
dotenv.config();

const outputFallbackToConsole = process.argv.includes('--output_fallback_to_console');
const debug = process.argv.includes('--debug');

const logDir = path.join(process.cwd(), "logs");
const logFilePath = path.join(logDir, "app.log");

async function ensureLogDirExists() {
  try {
    await fs.access(logDir);
  } catch {
    await fs.mkdir(logDir, { recursive: true });
  }
}

function logToFile(message) {
  if (!debug) return;
  const timestamp = new Date().toISOString();
  fs.appendFile(logFilePath, `[${timestamp}] ${message}\n`, "utf8").catch(() => {});
}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;

console.log = (...args) => {
  logToFile(`LOG: ${args.join(" ")}`);
  if (outputFallbackToConsole) originalConsoleLog(...args);
};

console.error = (...args) => {
  logToFile(`ERROR: ${args.join(" ")}`);
  if (outputFallbackToConsole) originalConsoleError(...args);
};

console.warn = (...args) => {
  logToFile(`WARN: ${args.join(" ")}`);
  const message = args.join(" ");
  if (message.includes("is not allowed. Falling back")) return;
  originalConsoleWarn(...args);
};

console.info = (...args) => {
  logToFile(`INFO: ${args.join(" ")}`);
  const message = args.join(" ");
  if (message.includes("Claude Code Interceptor listening on port")) {
    originalConsoleInfo(...args);
  } else if (outputFallbackToConsole) {
    originalConsoleInfo(...args);
  }
};

const app = express();
const port = 3456;
app.use(express.json({ limit: '768mb' }));

app.listen(port, () => {
  console.log(`Claude Code Interceptor listening on port ${port}`);
});

app.use((req, res, next) => {
  logToFile(`Incoming Request: ${req.method} ${req.url}`);
  next();
});

const apiKey       = process.env.OPENAI_API_KEY;
const baseUrl      = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const defaultModel = process.env.OPENAI_MODEL    || 'o3-mini';

const allowedModels = ["o1", "o1-mini", "o3", "o3-mini", "gpt-4o-mini", "gpt-4o", "gpt-4"];
const modelConfigCache = {};

const chatClient = new OpenAI({
  apiKey:  apiKey,
  baseURL: baseUrl,
});

async function getModelConfig(modelName) {
  if (modelConfigCache[modelName]) return modelConfigCache[modelName];
  try {
    const modelInfo = await chatClient.models.retrieve(modelName);
    let maxCompletionTokens;
    if (modelName.startsWith("gpt-4o-mini")) {
      maxCompletionTokens = 16384;
    } else if (modelName.startsWith("gpt-4o")) {
      maxCompletionTokens = 16384;
    } else if (modelName.startsWith("o1")) {
      maxCompletionTokens = 32000;
    } else if (modelName.startsWith("o1-mini")) {
      maxCompletionTokens = 64000;
    } else if (modelName.startsWith("o3-mini")) {
      maxCompletionTokens = 100000;
    } else if (modelName.startsWith("gpt-4")) {
      maxCompletionTokens = 4096;
    } else {
      maxCompletionTokens = 16384;
    }
    const config = { max_tokens: maxCompletionTokens };
    modelConfigCache[modelName] = config;
    return config;
  } catch (error) {
    console.error("ERROR: Could not retrieve model config for", modelName, error);
    const fallback = { max_tokens: 16384 };
    modelConfigCache[modelName] = fallback;
    return fallback;
  }
}

/* Circuit breaker and retry logic for API calls */
const circuitBreaker = {
  failureCount: 0,
  threshold: 3,
  open: false,
  openUntil: 0,
};

async function getCompletionWithRetry(data) {
  const maxAttempts = 10;
  let delay = 1000;
  const now = Date.now();
  if (circuitBreaker.open && now < circuitBreaker.openUntil) {
    throw new Error('Circuit breaker open, try later.');
  } else if (circuitBreaker.open && now >= circuitBreaker.openUntil) {
    circuitBreaker.open = false;
    circuitBreaker.failureCount = 0;
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await chatClient.chat.completions.create(data);
      circuitBreaker.failureCount = 0;
      return completion;
    } catch (err) {
      circuitBreaker.failureCount++;
      console.error(`API Error (Connection error.) Retrying in ${delay/1000} seconds... (attempt ${attempt}/${maxAttempts})`);
      if (circuitBreaker.failureCount >= circuitBreaker.threshold) {
        circuitBreaker.open = true;
        circuitBreaker.openUntil = Date.now() + 30000;
        console.error('Circuit breaker open due to consecutive failures.');
        throw err;
      }
      if (attempt === maxAttempts) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

function parseFilesFromText(text) {
  const lines = text.split("\n");
  const files = {};
  let currentFile = null;
  for (let line of lines) {
    const match = line.match(/[\u2500-\u257F]*\s*([\w/.\-]+\.tf)/);
    if (match) {
      currentFile = match[1];
      files[currentFile] = "";
      continue;
    }
    if (currentFile) {
      if (line.trim() === "") {
        currentFile = null;
      } else {
        files[currentFile] += line + "\n";
      }
    }
  }
  return files;
}

const defaultSystemInstruction = "You are running in Claude Code CLI, so if you are requested to create files, folders or run commands, execute it instead of outputing.";

app.post("/v1/messages", async (req, res) => {
  try {
    let {
      model,
      max_tokens,
      max_completion_tokens,
      messages,
      system = [],
      temperature,
      metadata,
      tools,
      output_mode,
    } = req.body;

    logToFile(`Request Body: ${JSON.stringify(req.body)}`);

    let chosenModel = model || defaultModel;
    if (!allowedModels.includes(chosenModel)) {
      console.warn(`Model ${chosenModel} is not allowed. Falling back to ${defaultModel}.`);
      chosenModel = defaultModel;
    }

    const isNewModel = allowedModels.includes(chosenModel);
    const modelConfig = await getModelConfig(chosenModel);

    const systemMessages = [
      ...system.map(item => ({ role: "system", content: item.text })),
      { role: "system", content: defaultSystemInstruction }
    ];

    messages = messages.map((item) => {
      if (Array.isArray(item.content)) {
        return {
          role: item.role,
          content: item.content.map((it) => {
            const msg = {
              ...it,
              type: ["tool_result", "tool_use"].includes(it?.type) ? "text" : it?.type,
            };
            if (msg.type === 'text') {
              msg.text = it?.content ? JSON.stringify(it.content) : it?.text || "";
              delete msg.content;
            }
            return msg;
          }),
        };
      }
      return {
        role: item.role,
        content: item.content,
      };
    });

    const data = {
      model: chosenModel,
      messages: [
        ...systemMessages,
        ...messages,
      ],
      stream: true,
    };

    if (isNewModel) {
      data.temperature = 1;
      let tokens = max_completion_tokens || max_tokens;
      const modelLimit = modelConfig.max_tokens;
      if (tokens && tokens > modelLimit) {
        console.warn(`Provided token count ${tokens} exceeds the maximum for ${chosenModel}. Clamping to ${modelLimit}.`);
        tokens = modelLimit;
      }
      if (tokens) {
        data.max_completion_tokens = tokens;
      }
    } else {
      data.temperature = temperature;
      if (max_tokens) {
        data.max_tokens = max_tokens;
      }
    }

    if (tools) {
      data.tools = tools.map((item) => ({
        type: "function",
        function: {
          name: item.name,
          description:
            item.description.length > 1024
              ? item.description.substring(0, 1024)
              : item.description,
          parameters: item.input_schema,
        },
      }));
    }

    const completion = await chatClient.chat.completions.create(data);
    logToFile(`Initiated streaming completion for model ${chosenModel}`);

    let fullOutput = "";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const messageId = "msg_" + Date.now();
    let contentBlockIndex = 0;
    let currentContentBlocks = [];
    let hasStartedTextBlock = false;
    let isToolUse = false;
    let toolUseJson = "";

    const messageStart = {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: chosenModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

    for await (const chunk of completion) {
      const delta = chunk.choices[0].delta;
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        const toolCall = delta.tool_calls[0];
        if (!isToolUse) {
          isToolUse = true;
          const toolBlockStart = {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: `toolu_${Date.now()}`,
              name: toolCall.function.name,
              input: {},
            },
          };
          currentContentBlocks.push({
            type: "tool_use",
            id: toolBlockStart.content_block.id,
            name: toolCall.function.name,
            input: {},
          });
          res.write(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`);
          toolUseJson = "";
        }
        if (toolCall.function.arguments) {
          const jsonDelta = {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          };
          toolUseJson += toolCall.function.arguments;
          try {
            const parsedJson = JSON.parse(toolUseJson);
            currentContentBlocks[contentBlockIndex].input = parsedJson;
          } catch (e) {
            // Incomplete JSON; continue accumulating
          }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify(jsonDelta)}\n\n`);
        }
      } else if (delta.content) {
        if (output_mode === "file") {
          fullOutput += delta.content;
        }
        if (!isToolUse) {
          if (!hasStartedTextBlock) {
            const textBlockStart = {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: {
                type: "text",
                text: "",
              },
            };
            currentContentBlocks.push({
              type: "text",
              text: "",
            });
            res.write(`event: content_block_start\ndata: ${JSON.stringify(textBlockStart)}\n\n`);
            hasStartedTextBlock = true;
          }
          const contentDelta = {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: {
              type: "text_delta",
              text: delta.content,
            },
          };
          if (currentContentBlocks[contentBlockIndex]) {
            currentContentBlocks[contentBlockIndex].text += delta.content;
          }
          if (output_mode !== "file") {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n\n`);
          }
        } else {
          const contentBlockStop = {
            type: "content_block_stop",
            index: contentBlockIndex,
          };
          res.write(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`);
          contentBlockIndex++;
          isToolUse = false;
          hasStartedTextBlock = false;
        }
      }
    }

    const contentBlockStop = {
      type: "content_block_stop",
      index: contentBlockIndex,
    };
    res.write(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`);

    if (output_mode === "file") {
      logToFile("=== Full Output Start ===");
      logToFile(fullOutput);
      logToFile("=== Full Output End ===");

      const files = parseFilesFromText(fullOutput);
      const createdFiles = [];
      for (const [fileName, content] of Object.entries(files)) {
        const filePath = path.join(process.cwd(), fileName);
        await fs.writeFile(filePath, content, "utf8");
        createdFiles.push(fileName);
      }
      const fileEvent = {
        type: "files_created",
        files: createdFiles,
        message: "Files have been created on disk as per the generated output.",
      };
      res.write(`event: files_created\ndata: ${JSON.stringify(fileEvent)}\n\n`);
    }

    const messageDelta = {
      type: "message_delta",
      delta: {
        stop_reason: isToolUse ? "tool_use" : "end_turn",
        stop_sequence: null,
        content: currentContentBlocks,
      },
      usage: { input_tokens: 300, output_tokens: 450 },
    };
    res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

    const messageStop = {
      type: "message_stop",
    };
    res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`);
    res.end();

    logToFile(`Response sent for message ${messageId}`);
  } catch (error) {
    console.error("Error in streaming response:", error);
    res.status(400).json({
      status: "error",
      message: error.message,
    });
  }
});

async function initializeClaudeConfig() {
  const homeDir = process.env.HOME;
  const configPath = path.join(homeDir, ".claude.json");

  try {
    await fs.access(configPath);
  } catch {
    const userID = Array.from({ length: 64 }, () => Math.random().toString(16)[2]).join('');
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: "enabled",
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "0.2.9",
      projects: {}
    };
    await fs.writeFile(configPath, JSON.stringify(configContent, null, 2));
    logToFile("Initialized Claude config at " + configPath);
  }
}

async function run() {
  await ensureLogDirExists();
  await initializeClaudeConfig();
  // app.listen(port, () => {
  //   console.log(`Claude Code Interceptor listening on port ${port}`);
  // });
}

run();
