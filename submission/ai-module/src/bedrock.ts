import { z } from 'zod';

type StructuredObjectInput<T> = {
  schema: z.ZodSchema<T>;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
};

let cachedRuntime: unknown = null;

const getRuntime = () => {
  if (cachedRuntime) {
    return cachedRuntime as {
      BedrockRuntimeClient: new (input: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
      ConverseCommand: new (input: Record<string, unknown>) => unknown;
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cachedRuntime = require('@aws-sdk/client-bedrock-runtime');
  return cachedRuntime as {
    BedrockRuntimeClient: new (input: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
    ConverseCommand: new (input: Record<string, unknown>) => unknown;
  };
};

const getModelId = () => {
  const modelId = process.env.AI_BEDROCK_MODEL_ID?.trim();
  if (!modelId) {
    throw new Error('AI_MODEL_NOT_CONFIGURED');
  }
  return modelId;
};

const extractJsonBlock = (value: string) => {
  const fenced = value.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    return fenced.trim();
  }
  const objectStart = value.indexOf('{');
  const objectEnd = value.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return value.slice(objectStart, objectEnd + 1);
  }
  throw new Error('BEDROCK_JSON_NOT_FOUND');
};

const readResponseText = (response: unknown) => {
  const content = (response as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  })?.output?.message?.content;

  const text = Array.isArray(content)
    ? content.map((item) => item?.text ?? '').filter(Boolean).join('\n')
    : '';

  if (!text) {
    throw new Error('BEDROCK_EMPTY_RESPONSE');
  }
  return text;
};

export const generateStructuredObject = async <T>(input: StructuredObjectInput<T>) => {
  const runtime = getRuntime();
  const modelId = getModelId();
  const client = new runtime.BedrockRuntimeClient({
    region: process.env.AI_BEDROCK_REGION ?? process.env.AWS_REGION
  });

  const command = new runtime.ConverseCommand({
    modelId,
    system: [{ text: input.systemPrompt }],
    messages: [
      {
        role: 'user',
        content: [{ text: input.userPrompt }]
      }
    ],
    inferenceConfig: {
      maxTokens: input.maxTokens ?? 900,
      temperature: input.temperature ?? 0.2
    }
  });

  const response = await client.send(command);
  const rawText = readResponseText(response);
  const data = input.schema.parse(JSON.parse(extractJsonBlock(rawText)));

  return {
    data,
    modelId,
    rawText
  };
};
