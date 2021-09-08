import { discriminator } from '@birchill/discriminator';
import * as s from 'superstruct';

const SearchRequestSchema = s.type({
  input: s.string(),
  includeRomaji: s.optional(s.boolean()),
});

export type SearchRequest = s.Infer<typeof SearchRequestSchema>;

export const BackgroundRequestSchema = discriminator('type', {
  disabled: s.type({}),
  'enable?': s.type({}),
  enabled: s.type({
    src: s.string(),
  }),
  options: s.type({}),
  // TODO: Remove 'search' once we have shipped the two-step search approach.
  //
  // It is provided now for the sake of supporting content scripts from previous
  // versions.
  search: SearchRequestSchema,
  searchWords: SearchRequestSchema,
  searchOther: SearchRequestSchema,
  switchedDictionary: s.type({}),
  toggleDefinition: s.type({}),
  translate: s.type({
    input: s.string(),
    includeRomaji: s.optional(s.boolean()),
  }),

  // Requests that should be relayed to the top-most frame in a tab.
  //
  // We send these messages via the background page simply because using
  // postMessage causes some Web pages to break when they encounter unrecognized
  // messages.
  'frame:highlightText': s.type({ length: s.number(), frameId: s.number() }),
  'frame:clearTextHighlight': s.type({ frameId: s.number() }),
});

export type BackgroundRequest = s.Infer<typeof BackgroundRequestSchema>;
