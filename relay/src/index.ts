/**
 * Smart Cursor Relay - Cloudflare Worker / Serverless Proxy
 * Holds Gemini & TTS keys safely away from browser client bundles.
 */

// Keep narration pacing calm and consistent for guided walkthroughs aimed at older users.
export const DEFAULT_TTS_VOICE = 'en-US-Neural2-F'; // Natural, easy-to-follow Google Neural2 voice
export const DEFAULT_SPEAKING_RATE = 0.93; // Calmer, unhurried pace for clear educational walkthroughs
export const ACCESSIBILITY_SPEAKING_RATE = 0.85; // Slower pace for accessibility mode

export interface Env {
  GEMINI_API_KEY: string;
  GOOGLE_TTS_API_KEY?: string;
}

export interface TourItem {
  title: string;
  element_id: string;
  summary: string;
  why_this_order?: string;
  is_risky?: boolean;
  risk_note?: string;
  jargon_terms?: string[];
}

export interface TourSection {
  section_title: string;
  section_summary: string;
  why_this_order?: string;
  items: TourItem[];
}

export interface TourResponsePayload {
  site_orientation: string;
  tour: TourSection[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // POST /api/tour - Two-level tour generation (Sections -> Comprehensive Items within each)
      if (url.pathname === '/api/tour') {
        const body = await request.json() as {
          page_url: string;
          page_title: string;
          page_context?: string;
          elements: Array<{ id: string; type: string; text: string }>;
          known_site_orientation?: string;
          user_goal?: string;
        };

        const orientationContext = body.known_site_orientation 
          ? `\nKNOWN SITE ORIENTATION FROM PREVIOUS PAGES THIS SESSION:\n"${body.known_site_orientation}"\n(Build on this known orientation rather than re-inferring from scratch when appropriate.)\n` 
          : '';

        const userGoalContext = body.user_goal 
          ? `\nUSER'S STATED GOAL:\n"${body.user_goal}"\n(Prioritize sections and items relevant to this goal where logical flow permits.)\n` 
          : '';

        const basePrompt = `You are an expert UX educator analyzing a webpage to create a clear, comprehensive, two-level educational walkthrough.

PAGE TITLE: ${body.page_title}
PAGE URL: ${body.page_url || ''}
${orientationContext}${userGoalContext}
PAGE ELEMENTS:
${JSON.stringify(body.elements, null, 2)}

Identify the natural SECTIONS of this page based on its content and structure — group elements that share a clear functional purpose (e.g. a "Shipping" section, a "Payment" section, an "Account Settings" section). Do not force a fixed number of sections; use however many genuinely exist on this page, from just one to several. Skip navigation chrome, ads, footers, and cookie banners as their own sections.

For each section, provide:
- section_title: short plain-language name
- section_summary: 1-2 sentences on what this section is FOR, before describing any individual element inside it — a user should understand the section's purpose before seeing its parts
- why_this_order: short reason this section comes at this point in the sequence (foundational/orientational sections first, prerequisite sections before dependent ones, user's stated goal prioritized where it doesn't break prerequisite logic)
- items: an array covering the elements within this section that matter for understanding it — include as many as genuinely help someone understand and use this section, not limited to a small fixed count. Trivial/redundant elements (e.g. a decorative icon next to a labeled button) can be skipped, but don't omit meaningful fields, buttons, or controls just to keep the list short.

Each item needs:
- title: short plain-language name (3-6 words)
- element_id: matching one of the ID values from PAGE ELEMENTS above (strictly never invent IDs)
- summary: one clear sentence explaining what this element does in plain everyday language
- why_this_order: brief reason for its position within the section
- is_risky: boolean — true if this element performs an irreversible or high-stakes action (submit, delete, pay, confirm, cancel subscription, reset data, etc.)
- risk_note: if is_risky is true, a short warning in plain language (e.g. "This finalizes your order — you can't undo it after this."); empty string "" if not risky
- jargon_terms: an array of any technical/unfamiliar terms used in this item's summary that a non-technical person might not know (e.g. ["APR", "escrow"]); empty array [] if none

Use plain, everyday language throughout. Avoid jargon and technical terms where a simpler word exists.

Keep each section_summary and each capability bullet focused on exactly ONE idea — do not combine multiple distinct actions or concepts into a single sentence with "and"/commas stacking ideas. If a capability genuinely has two parts, split it into two bullets instead of one dense one.

When a section's purpose can be usefully compared to something familiar from everyday life outside of computers or technology (e.g. signing a form, sorting mail, checking a receipt), include that comparison briefly in section_summary — this helps someone connect a new interface to something they already understand. Only do this when a genuinely natural comparison exists; do not force a comparison that feels like a stretch.

Do not restate the same information in section_summary that is already explained in why_this_order. Use section_summary to explain purpose and use why_this_order only to explain sequencing logic.
Do not repeat the site_orientation sentence in each section or in each item summary. Keep site_orientation as the single high-level overview for the tour, and let each section_summary add only its own local purpose.

Also infer the overall purpose of this SITE (not just this page) from the page content and any visible navigation/menu/header/footer links included in the elements list. Return this as "site_orientation" — one to two plain sentences, e.g. "This looks like an online pharmacy for ordering prescription medicines and tracking deliveries."

Respond ONLY in this JSON format, no markdown code fences, no extra text:
{
  "site_orientation": "...",
  "tour": [
    {
      "section_title": "...",
      "section_summary": "...",
      "why_this_order": "...",
      "items": [
        {
          "title": "...",
          "element_id": "el-1",
          "summary": "...",
          "why_this_order": "...",
          "is_risky": false,
          "risk_note": "",
          "jargon_terms": []
        }
      ]
    }
  ]
}`;

        const callGeminiTour = async (promptText: string) => {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.2,
                },
              }),
            }
          );
          if (!geminiRes.ok) {
            throw new Error(`Gemini API returned status ${geminiRes.status}`);
          }
          const geminiData = await geminiRes.json() as any;
          return geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
        };

        let parsed: any = null;
        try {
          const rawText = await callGeminiTour(basePrompt);
          const cleanText = rawText.replace(/```json|```/g, '').trim();
          parsed = JSON.parse(cleanText);
        } catch (firstErr) {
          // Attempt 2: JSON retry with strict schema enforcement
          try {
            const retryPrompt = `${basePrompt}\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY valid JSON matching the nested { "site_orientation": "...", "tour": [ { "section_title": "...", "section_summary": "...", "items": [...] } ] } schema. No markdown formatting, no code fences.`;
            const retryRaw = await callGeminiTour(retryPrompt);
            const cleanRetry = retryRaw.replace(/```json|```/g, '').trim();
            parsed = JSON.parse(cleanRetry);
          } catch (secondErr) {
            return new Response(JSON.stringify({ error: 'tour_generation_failed' }), {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        }

        if (parsed && Array.isArray(parsed.tour) && parsed.tour.length > 0) {
          // Validate and sanitize response shape
          const siteOrientation = typeof parsed.site_orientation === 'string' && parsed.site_orientation.trim().length > 0
            ? parsed.site_orientation.trim()
            : `This service provides interactive tools for ${body.page_title || 'this workflow'}.`;

          return new Response(JSON.stringify({
            site_orientation: siteOrientation,
            tour: parsed.tour,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ error: 'tour_generation_failed' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // POST /api/explain - Contextual explanation with risk awareness, jargon definitions & prior context
      if (url.pathname === '/api/explain') {
        const body = await request.json() as {
          element_type: string;
          element_text: string;
          page_context: string;
          familiarity: 'beginner' | 'experienced';
          step_n?: number | null;
          step_total?: number | null;
          site_orientation?: string;
          prior_context?: Array<{ title: string; summary: string }>;
          is_accessibility_mode?: boolean;
        };

        const isTourStep = (typeof body.step_n === 'number' && typeof body.step_total === 'number');
        const stepContext = isTourStep ? `\nTHIS IS STEP ${body.step_n} OF ${body.step_total} IN A GUIDED WALKTHROUGH.` : '';
        const siteOrientationContext = body.site_orientation ? `\nSITE ORIENTATION: "${body.site_orientation}"` : '';

        let priorContextText = '';
        if (Array.isArray(body.prior_context) && body.prior_context.length > 0) {
          const priorLines = body.prior_context
            .slice(-5)
            .map((c) => `- "${c.title}": ${c.summary}`)
            .join('\n');
          priorContextText = `\nPREVIOUSLY EXPLAINED IN THIS SESSION:\n${priorLines}\n\nIf this element or section genuinely relates to something already explained above, make that connection explicit in your explanation (e.g. "Like the Shipping section you just saw, this also affects your total cost."). Only make a connection if it's real and useful — don't force one if there isn't a meaningful relationship.\n`;
        }

        const prompt2 = `You are a friendly, concise tutor helping someone understand a webpage element in real time, as part of a guided walkthrough.

ELEMENT: ${body.element_type} — "${body.element_text}"
PAGE CONTEXT: ${body.page_context}${stepContext}${siteOrientationContext}
USER FAMILIARITY: ${body.familiarity}
${priorContextText}
If familiarity is "beginner": explain simply, assume no prior knowledge of this type of site, avoid jargon.
If familiarity is "experienced": skip basic framing, focus on nuance or details a first-time user wouldn't need — assume they already understand the general purpose of this site.

Use plain, everyday language throughout. Avoid jargon and technical terms where a simpler word exists. If a technical or unfamiliar term is genuinely necessary, use it but make sure it's listed in "jargon_terms" with a one-sentence plain definition for each, e.g. { "term": "APR", "definition": "the yearly cost of borrowing money, shown as a percentage" }.

Explain what this element does and why someone would use it. 2-3 sentences maximum. Plain, warm, simple language. Do not repeat the element's literal label back at the start of your explanation (skip "This is the X button" — just explain what it does).

Also evaluate if this element performs an irreversible or high-stakes action (e.g. submit, delete, pay, finalize, confirm, cancel subscription). If so, set "is_risky": true and provide a "risk_note" warning in plain language (e.g. "This finalizes your order — you can't undo it after this.").

Respond ONLY in valid JSON with this shape:
{
  "headline": "short 3-5 word action headline",
  "explanation": "2-3 plain sentences",
  "is_risky": false,
  "risk_note": "",
  "jargon_terms": [
    { "term": "...", "definition": "..." }
  ],
  "whyItMatters": "1 concise sentence on user or workflow value",
  "proTip": "1 practical shortcut or tip"
}`;

        try {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt2 }] }],
                generationConfig: { 
                  responseMimeType: 'application/json',
                  temperature: 0.25 
                }
              })
            }
          );

          const geminiData = await geminiRes.json() as any;
          const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
          const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());

          return new Response(JSON.stringify({
            headline: parsed.headline || `Focus: ${body.element_text.slice(0, 24)}`,
            explanation: parsed.explanation || `Interacting with this ${body.element_type} updates your progress and adjusts page options.`,
            is_risky: !!parsed.is_risky,
            risk_note: parsed.risk_note || '',
            jargon_terms: Array.isArray(parsed.jargon_terms) ? parsed.jargon_terms : [],
            whyItMatters: parsed.whyItMatters || '',
            proTip: parsed.proTip || '',
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } catch (explainErr: any) {
          return new Response(JSON.stringify({
            headline: `Focus: ${body.element_text.slice(0, 24)}`,
            explanation: `Interacting with this ${body.element_type} updates your progress and adjusts page options.`,
            is_risky: false,
            risk_note: '',
            jargon_terms: [],
            whyItMatters: 'Helps complete your configuration safely.',
            proTip: 'Press Enter or click to interact.'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      // POST /api/speak - Natural Neural2 Text-to-Speech synthesis with rate calibration
      if (url.pathname === '/api/speak') {
        const body = await request.json() as { 
          text: string; 
          speaking_rate?: number;
          is_accessibility_mode?: boolean;
        };
        const textToSpeak = (body.text || '').trim();

        if (!textToSpeak) {
          return new Response(JSON.stringify({ audio_base64: null, error: 'Empty text provided' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const ttsApiKey = env.GOOGLE_TTS_API_KEY;
        if (!ttsApiKey) {
          return new Response(JSON.stringify({ 
            audio_base64: null, 
            error: 'GOOGLE_TTS_API_KEY is not configured in worker environment' 
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Calibrate speaking rate: slower if accessibility mode is enabled
        const targetSpeakingRate = body.is_accessibility_mode 
          ? ACCESSIBILITY_SPEAKING_RATE 
          : (body.speaking_rate || DEFAULT_SPEAKING_RATE);

        try {
          const ttsRes = await fetch(
            `https://texttospeech.googleapis.com/v1/text:synthesize?key=${ttsApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                input: { text: textToSpeak },
                voice: {
                  languageCode: 'en-US',
                  name: DEFAULT_TTS_VOICE,
                  ssmlGender: 'FEMALE',
                },
                audioConfig: {
                  audioEncoding: 'MP3',
                  speakingRate: targetSpeakingRate,
                  pitch: 0, // Natural default pitch
                },
              }),
            }
          );

          if (!ttsRes.ok) {
            const errText = await ttsRes.text();
            return new Response(JSON.stringify({ audio_base64: null, error: `TTS failed: ${errText}` }), {
              status: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const ttsData = await ttsRes.json() as { audioContent?: string };
          return new Response(JSON.stringify({ audio_base64: ttsData.audioContent || null }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (ttsErr: any) {
          return new Response(JSON.stringify({ audio_base64: null, error: ttsErr.message || 'TTS request failed' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // POST /api/recap - 1-sentence tour completion recap
      if (url.pathname === '/api/recap') {
        const body = await request.json() as { tour_titles: string[]; page_title: string; site_orientation?: string };
        const titles = body.tour_titles || [];
        const pageTitle = body.page_title || 'this page';

        const promptRecap = `You are Smart Cursor. Generate a concise, friendly 1-sentence recap (max 25 words) in plain language summarizing what the user can now do on "${pageTitle}" (${body.site_orientation || ''}), based on these completed sections/actions: ${titles.join(', ')}. Return plain text only.`;

        try {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: promptRecap }] }],
                generationConfig: { temperature: 0.3 }
              })
            }
          );
          const geminiData = await geminiRes.json() as any;
          const recap = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || `You're all set! You've mastered the core actions on ${pageTitle}.`;
          return new Response(JSON.stringify({ recap }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ recap: `You're all set! You've mastered the core actions on ${pageTitle}.` }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      // POST /api/quiz - Comprehension question generation
      if (url.pathname === '/api/quiz') {
        const body = await request.json() as { explanation: string; element_text?: string };
        const promptQuiz = `Generate 1 short, engaging multiple-choice comprehension question based on this UI explanation:
"${body.explanation}"
(Element: "${body.element_text || 'Action'}")

Provide exactly 3 options. Return ONLY valid JSON in this shape:
{
  "question": "What is the primary function of this button/element?",
  "options": ["Option A", "Option B", "Option C"],
  "correct_index": 0
}`;

        try {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: promptQuiz }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
              })
            }
          );
          const geminiData = await geminiRes.json() as any;
          const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
          const quiz = JSON.parse(rawText.replace(/```json|```/g, '').trim());
          return new Response(JSON.stringify(quiz), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } catch (err: any) {
          return new Response(JSON.stringify({
            question: `How does ${body.element_text || 'this feature'} help you?`,
            options: ['Executes the primary workflow action', 'Closes the current browser tab', 'Exports system analytics'],
            correct_index: 0
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response(JSON.stringify({ status: 'ok', service: 'Smart Cursor Relay' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};


