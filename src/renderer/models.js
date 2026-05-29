/* Static model catalogue for the renderer (mirrors src/main/mistral.js).
 * Capabilities are display-only metadata for the About / model picker.
 * API names are the official `-latest` aliases (see https://docs.mistral.ai/getting-started/models). */
export const SUPPORTED_MODELS = [
  'mistral-large-latest',
  'mistral-medium-latest',
  'mistral-small-latest',
  'magistral-medium-latest',
  'magistral-small-latest',
  'codestral-latest',
  'devstral-medium-latest',
  'ministral-8b-latest',
  'pixtral-large-latest',
  'open-mistral-nemo'
];

/* Optional human grouping for the picker (label → model ids). */
export const MODEL_GROUPS = [
  ['General', ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest']],
  ['Reasoning', ['magistral-medium-latest', 'magistral-small-latest']],
  ['Code', ['codestral-latest', 'devstral-medium-latest']],
  ['Vision & edge', ['pixtral-large-latest', 'ministral-8b-latest', 'open-mistral-nemo']]
];

export const MODEL_INFO = {
  'mistral-large-latest': { context: '256k context', caps: ['flagship', 'function calling', 'vision', 'json mode'] },
  'mistral-medium-latest': { context: '128k context', caps: ['balanced', 'function calling', 'vision', 'json mode'] },
  'mistral-small-latest': { context: '128k context', caps: ['fast', 'function calling', 'json mode'] },
  'magistral-medium-latest': { context: '128k context', caps: ['reasoning', 'function calling'] },
  'magistral-small-latest': { context: '128k context', caps: ['reasoning', 'open weights'] },
  'codestral-latest': { context: '256k context', caps: ['code', 'fill-in-the-middle', 'function calling'] },
  'devstral-medium-latest': { context: '128k context', caps: ['coding agent', 'function calling'] },
  'ministral-8b-latest': { context: '128k context', caps: ['edge', 'fast', 'function calling'] },
  'pixtral-large-latest': { context: '128k context', caps: ['vision', 'function calling'] },
  'open-mistral-nemo': { context: '128k context', caps: ['open weights', 'fast'] }
};
