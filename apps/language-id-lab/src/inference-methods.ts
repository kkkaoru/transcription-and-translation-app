// Runs with Bun during build and test.

export type ContainerTier = "basic" | "standard";
export type ContainerModel = "speechbrain-ecapa" | "nvidia-ambernet";
export type ContainerInferenceMethod =
  | "speechbrain-ecapa-basic"
  | "speechbrain-ecapa-standard"
  | "nvidia-ambernet-basic"
  | "nvidia-ambernet-standard";
export type WorkersAiInferenceMethod = "workers-ai-nova-3";
export type InferenceMethod = ContainerInferenceMethod | WorkersAiInferenceMethod;

export interface InferenceMethodDefinition {
  id: InferenceMethod;
  provider: "private-container" | "workers-ai";
  model: string;
  tier: ContainerTier | null;
  languageCount: number | null;
}

export const INFERENCE_METHODS: readonly InferenceMethodDefinition[] = [
  {
    id: "speechbrain-ecapa-basic",
    provider: "private-container",
    model: "speechbrain/lang-id-voxlingua107-ecapa",
    tier: "basic",
    languageCount: 107,
  },
  {
    id: "speechbrain-ecapa-standard",
    provider: "private-container",
    model: "speechbrain/lang-id-voxlingua107-ecapa",
    tier: "standard",
    languageCount: 107,
  },
  {
    id: "nvidia-ambernet-basic",
    provider: "private-container",
    model: "nvidia/nemo-langid-ambernet",
    tier: "basic",
    languageCount: 107,
  },
  {
    id: "nvidia-ambernet-standard",
    provider: "private-container",
    model: "nvidia/nemo-langid-ambernet",
    tier: "standard",
    languageCount: 107,
  },
  {
    id: "workers-ai-nova-3",
    provider: "workers-ai",
    model: "@cf/deepgram/nova-3",
    tier: null,
    languageCount: null,
  },
];

const METHOD_IDS: ReadonlySet<string> = new Set(INFERENCE_METHODS.map((method) => method.id));

export const isInferenceMethod = (value: string): value is InferenceMethod => METHOD_IDS.has(value);

export const inferenceMethod = (id: InferenceMethod): InferenceMethodDefinition =>
  INFERENCE_METHODS.find((method) => method.id === id) ?? INFERENCE_METHODS[0];

export const isContainerInferenceMethod = (method: string): method is ContainerInferenceMethod =>
  isInferenceMethod(method) && inferenceMethod(method).provider === "private-container";
