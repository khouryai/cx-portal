import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const PROMPT = `This is the bottom portion of an engineering drawing sheet. Extract the title block fields and return ONLY a JSON object — no explanation, no markdown fences.

Required JSON format:
{
  "sheetNumber": "the drawing/contract sheet number code (e.g. TC115402-W40, P35, E-1001, M22A) or null",
  "sheetTitle": "the drawing title — a descriptive multi-word phrase (e.g. INTERLOCKING OVERVIEW, TRACK PLAN DETAIL) — or null",
  "revision": "revision code — 1 to 3 alphanumeric characters (e.g. A, B, 01, 00) — or null",
  "pageNumber": "page/sheet number digit(s) only — or null"
}

Rules:
- Return ONLY the value, never the label (e.g. for 'CONTRACT SHEET NO.: P35' return 'P35', not the label)
- sheetTitle must be a descriptive phrase with spaces — never a date, a code, or a single word that is a code
- revision must be 1–3 characters, not a word like 'REV' or 'REVISION'
- If a field is not clearly visible in the title block, use null`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY secret not configured' }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body: { imageBase64: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const { imageBase64, mimeType = 'image/jpeg' } = body;
  if (!imageBase64) {
    return new Response(JSON.stringify({ error: 'Missing imageBase64' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType as 'image/jpeg',
              data: imageBase64,
            },
          },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  });

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text().catch(() => '');
    console.error('[extract-drawing-fields] Anthropic error:', anthropicResp.status, errText);
    return new Response(JSON.stringify({ error: 'Anthropic API error', status: anthropicResp.status }), {
      status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const data = await anthropicResp.json().catch(() => ({}));
  const text: string = ((data.content ?? [])[0]?.text ?? '').trim();

  let result: Record<string, string | null> = {};
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) result = JSON.parse(match[0]);
  } catch { /* return empty on parse failure */ }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
});
