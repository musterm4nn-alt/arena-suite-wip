/**
 * Synthetic/golden sanitized protocol fixtures per §15 P2
 * Golden fixtures and property tests vary chunk boundaries/order/duplicates
 */

export const GOLDEN_STREAM_FIXTURES = [
  {
    name: "arena.chat.stream complete",
    transport: "chunked",
    payload_family: "arena.chat.stream",
    chunks: [
      `{"type":"start","conversation_id":"conv_123"}\n`,
      `{"type":"delta","text":"Hello"}\n`,
      `{"type":"delta","text":" world"}\n`,
      `{"type":"terminal","finish_reason":"stop"}\n`,
    ],
    expected_completeness: "complete",
    utf8_edge: "Hello world — emoji test: 🎉 café naïve",
  },
  {
    name: "arena.chat.stream stopped_by_user",
    transport: "chunked",
    payload_family: "arena.chat.stream",
    chunks: [
      `{"type":"start"}\n`,
      `{"type":"delta","text":"Partial"}\n`,
      `{"type":"abort","reason":"user_stop"}\n`,
    ],
    expected_completeness: "stopped_by_user",
    utf8_edge: "Partial — stop",
  },
  {
    name: "arena.chat.stream failed_transport",
    transport: "chunked",
    payload_family: "arena.chat.stream",
    chunks: [
      `{"type":"start"}\n`,
      `{"type":"delta","text":"Oops"}\n`,
    ],
    // no terminal, transport fails
    expected_completeness: "failed_transport",
    utf8_edge: "Oops",
  },
  {
    name: "rsc.flight",
    transport: "rsc",
    payload_family: "rsc.flight",
    chunks: [
      `0:["$","div",null,{"children":"RSC payload"}]\n`,
      `1:["$","$L1",null,{}]\n`,
    ],
    expected_completeness: "complete",
    utf8_edge: "RSC payload with unicode: 你好",
  },
  {
    name: "sse.events",
    transport: "sse",
    payload_family: "sse.events",
    chunks: [
      `data: {"event":"message","text":"hi"}\n\n`,
      `data: {"event":"done"}\n\n`,
    ],
    expected_completeness: "complete",
    utf8_edge: "hi",
  },
  {
    name: "ws.arena",
    transport: "websocket",
    payload_family: "ws.arena",
    chunks: [
      `{"op":"hello"}`,
      `{"op":"delta","text":"ws"}`,
      `{"op":"complete"}`,
    ],
    expected_completeness: "complete",
    utf8_edge: "ws",
  },
];

export const UTF8_BOUNDARY_TEST_STRINGS = [
  "Hello world",
  "café naïve résumé",
  "🎉🔥💀 emoji sequence",
  "Mixed: hello café 🎉 world — test",
  "中文测试 with English",
  "a".repeat(100) + "🎉".repeat(10),
  '{"text":"Hello \\"world\\" with \\\\ escapes"}',
];

export const DUPLICATE_CHUNK_TEST = {
  description: "Replayed chunks counted but not appended twice per §6.3",
  requestId: "req-dup-test",
  chunks: [
    { seq: 0, text: "Hello " },
    { seq: 1, text: "world" },
    { seq: 1, text: "world" }, // duplicate
    { seq: 2, text: "!" },
    { seq: 0, text: "Hello " }, // duplicate out of order
  ],
  expectedAssembled: "Hello world!",
  expectedDuplicateCount: 2,
};

export const BOUNDED_QUEUE_OVERFLOW_FIXTURE = {
  maxSize: 5,
  enqueueCount: 20,
  expectedDropped: 15,
};
