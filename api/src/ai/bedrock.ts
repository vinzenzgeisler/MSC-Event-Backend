import { z } from 'zod';

type StructuredObjectInput<T> = {
  schema: z.ZodSchema<T>;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
};

let cachedClient: unknown = null;

const extractJsonBlock = (value: string): string => {
  const fencedMatch = value.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  const objectStart = value.indexOf('{');
  const objectEnd = value.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return value.slice(objectStart, objectEnd + 1);
  }
  throw new Error('BEDROCK_JSON_NOT_FOUND');
};

const getRuntime = () => {
  if (cachedClient) {
    return cachedClient as {
      BedrockRuntimeClient: new (input: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
      ConverseCommand: new (input: Record<string, unknown>) => unknown;
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cachedClient = require('@aws-sdk/client-bedrock-runtime');
  return cachedClient as {
    BedrockRuntimeClient: new (input: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
    ConverseCommand: new (input: Record<string, unknown>) => unknown;
  };
};

const getModelId = (): string => {
  const modelId = process.env.AI_BEDROCK_MODEL_ID;
  if (!modelId || modelId.trim().length === 0) {
    throw new Error('AI_MODEL_NOT_CONFIGURED');
  }
  return modelId.trim();
};

const getRegion = (): string | undefined =>
  process.env.AI_BEDROCK_REGION ?? process.env.AWS_REGION ?? process.env.DB_REGION;

const readResponseText = (response: unknown): string => {
  const content = (response as {
    output?: {
      message?: {
        content?: Array<{ text?: string }>;
      };
    };
  })?.output?.message?.content;
  const text = Array.isArray(content)
    ? content
        .map((item) => item?.text ?? '')
        .filter((item) => item.length > 0)
        .join('\n')
    : '';
  if (!text) {
    throw new Error('BEDROCK_EMPTY_RESPONSE');
  }
  return text;
};

export const generateStructuredObject = async <T>(input: StructuredObjectInput<T>): Promise<{ data: T; modelId: string; rawText: string }> => {
  const runtime = getRuntime();
  const modelId = getModelId();
  const client = new runtime.BedrockRuntimeClient({
    region: getRegion()
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
