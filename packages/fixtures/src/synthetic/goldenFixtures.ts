/**
 * Golden fixtures and property tests vary chunk boundaries/order/duplicates per P2
 */

export interface GoldenStream {
  id: string;
  description: string;
  chunks: Uint8Array[];
  expectedText: string;
  expectedHash: string;
  duplicateIndices: number[];
  splitPoints: number[]; // UTF-8 boundary test points
}

export function createGoldenFixtures(): GoldenStream[] {
  const encoder = new TextEncoder();

  return [
    {
      id: 'simple-utf8',
      description: 'Simple UTF-8 text split at arbitrary boundaries',
      chunks: [
        encoder.encode('Hello '),
        encoder.encode('world! '),
        encoder.encode('This is a test.'),
      ],
      expectedText: 'Hello world! This is a test.',
      expectedHash: 'placeholder',
      duplicateIndices: [],
      splitPoints: [0, 6, 13],
    },
    {
      id: 'utf8-boundary',
      description: 'Multi-byte UTF-8 characters split mid-sequence',
      chunks: (() => {
        const text = 'Hello 🌍 world — test café';
        const bytes = encoder.encode(text);
        // Split at every byte to test boundary handling
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < bytes.length; i++) {
          chunks.push(bytes.slice(i, i + 1));
        }
        return chunks;
      })(),
      expectedText: 'Hello 🌍 world — test café',
      expectedHash: 'placeholder',
      duplicateIndices: [],
      splitPoints: [],
    },
    {
      id: 'duplicate-chunks',
      description: 'Replayed chunks counted but not appended twice',
      chunks: [
        encoder.encode('First chunk '),
        encoder.encode('Second chunk '),
        encoder.encode('Second chunk '), // duplicate
        encoder.encode('Third chunk'),
      ],
      expectedText: 'First chunk Second chunk Third chunk',
      expectedHash: 'placeholder',
      duplicateIndices: [2],
      splitPoints: [],
    },
    {
      id: 'rsc-like',
      description: 'RSC/Flight-like payload with interleaved JSON and binary',
      chunks: [
        encoder.encode('{"type":"text","content":"Hello"}\n'),
        encoder.encode('{"type":"tool","name":"search"}\n'),
        encoder.encode('{"type":"text","content":" world"}\n'),
      ],
      expectedText: '{"type":"text","content":"Hello"}\n{"type":"tool","name":"search"}\n{"type":"text","content":" world"}\n',
      expectedHash: 'placeholder',
      duplicateIndices: [],
      splitPoints: [],
    },
  ];
}
