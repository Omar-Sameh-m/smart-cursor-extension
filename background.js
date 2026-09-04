/**
 * Background service worker for Smart Cursor.
 * This file owns the local Gemini requests and keeps the AI key in a generated config file instead of the UI.
 */

import { GEMINI_API_KEY } from './config.local.js';

const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_KEY_HELP = 'Set GEMINI_API_KEY in .env and run npm run build before loading the extension.';

function getConfiguredGeminiApiKey() {
  return typeof GEMINI_API_KEY === 'string' ? GEMINI_API_KEY.trim() : '';
}

function buildGeminiUrl(apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

async function callGemini(prompt, jsonMode = true) {
  const apiKey = getConfiguredGeminiApiKey();
  if (!apiKey) {
    throw new Error('gemini_key_missing');
  }

  const res = await fetch(buildGeminiUrl(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || (jsonMode ? '{}' : '');
}

function cleanAndParseJSON(rawText) {
  if (!rawText) return {};

  let cleaned = rawText.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    try {
      const sanitized = cleaned
        .replace(/[\u0000-\u001F]+/g, ' ')
        .replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(sanitized);
    } catch (secondErr) {
      console.error('Failed to parse JSON from Gemini response:', rawText, secondErr);
      throw new Error('AI returned an unreadable response format. Please click Try Again.');
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const ensureGeminiKey = () => {
    const apiKey = getConfiguredGeminiApiKey();
    if (!apiKey) {
      throw new Error('gemini_key_missing');
    }
  };

  (async () => {
    try {
      if (message.action === 'FETCH_TOUR') {
        await ensureGeminiKey();
        const { page_url, page_title, elements } = message.payload;
        const prompt = `You are an expert UX educator analyzing a webpage to create a clear, high-level, section-by-section educational walkthrough for elderly, non-technical users.

PAGE TITLE: ${page_title}
PAGE URL: ${page_url || ''}
PAGE ELEMENTS (Including visual landmark sections & primary call-to-action indicators):
${JSON.stringify(elements, null, 2)}

INSTRUCTIONS & PRIORITY HIERARCHY:
1. Use the provided landmark_section ("Main Hero Section", "Interactive Form", "Header Navigation", etc.) and is_primary_cta flags to prioritize what matters most to a user.
2. Section 1 MUST ALWAYS cover the main core purpose/hero of the page and primary CTAs (e.g. main service button, primary search, or core value offer).
3. Subsequent sections should cover primary interactive forms and key tools.
4. Skip ads, cookie banners, and low-priority decorative/legal footer links.

For each section, generate:
- section_title: short plain-language name
- section_summary: 1-2 sentences explaining what this section is FOR in plain everyday language.
- capabilities: an array of 3 to 6 comprehensive, outcome-focused bullet-point strings. The tour must cover a wide overview of the section's core functions and important capabilities without getting bogged down in minor sub-menus or legal links. Describe key outcomes, primary tools, and important user actions available in this section. Each bullet must be 8-16 words in plain everyday language.
- why_this_order: short reason this section comes at this point in the sequence.
- is_risky: boolean — set to true if this section as a whole contains ANY irreversible or high-stakes action (delete, pay, submit, finalize order, cancel subscription, reset data).
- section_risk_note: if is_risky is true, a short warning appropriate for someone viewing the section as a whole (e.g. "Some actions in this section cannot be undone once confirmed."); empty string "" if not risky.
- items: array covering elements within this section that can be clicked for individual detail.

Each item inside items needs:
- title: short plain-language name (3-6 words)
- element_id: MUST match one of the IDs from PAGE ELEMENTS exactly — never invent IDs
- summary: one clear sentence in plain everyday language explaining what this specific element does
- why_this_order: brief reason for its position within the section
- is_risky: boolean — true if this element performs an irreversible/high-stakes action
- risk_note: warning note if is_risky is true; empty string "" if not risky
- jargon_terms: array of technical terms used in the summary. Format: [{"term":"...", "definition":"..."}]

Also infer the overall purpose of this SITE from page content and navigation. Return as "site_orientation" — 1-2 plain sentences.

Respond ONLY in this exact JSON format, no markdown, no code fences:
{
  "site_orientation": "...",
  "tour": [
    {
      "section_title": "...",
      "section_summary": "...",
      "capabilities": [
        "...",
        "..."
      ],
      "why_this_order": "...",
      "is_risky": false,
      "section_risk_note": "",
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

        const text = await callGemini(prompt, true);
        const parsed = cleanAndParseJSON(text);
        if (parsed && Array.isArray(parsed.tour) && parsed.tour.length > 0) {
          sendResponse({ success: true, data: parsed });
          return;
        }

        sendResponse({ success: false, error: 'AI returned an empty tour. Please retry.' });
        return;
      }

      if (message.action === 'FETCH_EXPLAIN') {
        await ensureGeminiKey();
        const { element_type, element_text, page_context, familiarity, step_n, step_total } = message.payload;
        const stepCtx = typeof step_n === 'number' ? `\nTHIS IS STEP ${step_n} OF ${step_total} IN A GUIDED WALKTHROUGH.` : '';

        const prompt = `You are a friendly, concise tutor helping an elderly person understand a webpage element during a guided walkthrough.

ELEMENT: ${element_type} — "${element_text}"
PAGE CONTEXT: ${page_context}${stepCtx}
USER FAMILIARITY: ${familiarity}

${familiarity === 'beginner'
  ? 'Write as if talking to a grandparent using the internet for the first time. Simple, warm, zero jargon. Assume no technical knowledge.'
  : 'Be concise. Focus on what matters. Skip basic framing.'}

Explain what this element does and why someone would use it. 2-3 sentences maximum. Do NOT repeat the element label at the start.

If this element performs an irreversible or high-stakes action (submit, delete, pay, finalize, cancel subscription), set "is_risky": true and write a plain-language warning.

If you use any technical term that a non-technical person might not know, list it in "jargon_terms" with a one-sentence plain definition.

Respond ONLY in valid JSON:
{
  "explanation": "2-3 plain sentences",
  "is_risky": false,
  "risk_note": "",
  "jargon_terms": [
    { "term": "...", "definition": "..." }
  ]
}`;

        const text = await callGemini(prompt, true);
        const parsed = cleanAndParseJSON(text);
        sendResponse({
          success: true,
          data: {
            explanation: parsed.explanation || `This ${element_type} helps you interact with the page.`,
            is_risky: !!parsed.is_risky,
            risk_note: parsed.risk_note || '',
            jargon_terms: Array.isArray(parsed.jargon_terms) ? parsed.jargon_terms : [],
          },
        });
        return;
      }

      if (message.action === 'FETCH_ORIENTATION') {
        await ensureGeminiKey();
        const { page_title, page_url, elements } = message.payload;
        const elementSample = (elements || []).slice(0, 20).map((e) => e.text).join(', ');

        const prompt = `In 1-2 plain sentences, explain to an elderly person what this website is for and what they can do on this specific page. Keep it very simple, warm, and jargon-free.

Page title: ${page_title}
Page URL: ${page_url}
Visible elements on this page include: ${elementSample}

Return ONLY plain text — no JSON, no bullet points, no formatting. Example: "This is an online banking website. On this page, you can check your account balance and see your recent transactions."`;

        const text = await callGemini(prompt, false);
        sendResponse({ success: true, data: { orientation: text } });
        return;
      }

      if (message.action === 'ASK_QUESTION') {
        await ensureGeminiKey();
        const { question, page_title, page_url, elements } = message.payload;
        const elementList = (elements || []).slice(0, 80).map((e) => `[ID: ${e.id}] ${e.type} "${e.text}" (${e.position_hint || 'page body'})`).join('\n');

        const prompt = `You are Smart Cursor, an expert, warm, and friendly website guide helping an elderly or non-technical user navigate the current website.

USER QUESTION: "${question}"
PAGE TITLE: ${page_title}
PAGE URL: ${page_url || ''}

SCANNED PAGE ELEMENTS:
${elementList}

INSTRUCTIONS:
1. Perform intelligent, fuzzy/semantic matching against all scanned elements on the page. For example, if the user asks "where is the apply for coverage", look for any button, link, or heading matching "Apply for coverage" or related terms.
2. If the user asks where an item is or how to complete a specific action:
   - Identify the exact element on the page.
   - If it's a single element: Provide a clear, friendly explanation of its exact location and appearance (e.g., "Look for the green button labeled 'Apply for coverage' near the top of the page.").
   - If it requires a multi-step navigation flow: Provide a step-by-step action flow using arrows (e.g., "Open Settings (top right) → Click Passwords → Select Change Password").
3. Always pick the single best matching element ID from the SCANNED PAGE ELEMENTS list and put it in "target_element_id". If no specific element matches, set "target_element_id" to null.
4. Keep the answer friendly, plain, and direct (2-3 sentences max). Do NOT use jargon or technical terms.

Return strictly valid JSON matching this schema:
{
  "answer": "Clear, friendly explanation or step-by-step action flow with arrows",
  "target_element_id": "el-X" or null
}`;

        const text = await callGemini(prompt, true);
        try {
          const parsed = cleanAndParseJSON(text);
          sendResponse({
            success: true,
            data: {
              answer: parsed.answer || 'Here is what I found on this page.',
              target_element_id: parsed.target_element_id || null,
            },
          });
        } catch (error) {
          sendResponse({
            success: true,
            data: {
              answer: text.replace(/```json/g, '').replace(/```/g, '').trim(),
              target_element_id: null,
            },
          });
        }
        return;
      }

      if (message.action === 'FETCH_RECAP') {
        await ensureGeminiKey();
        const { tour_titles, page_title } = message.payload;
        const prompt = `Generate a concise, friendly 1-sentence recap (max 25 words) in plain language summarizing what the user can now do on "${page_title}", based on these completed actions: ${tour_titles.join(', ')}. Return plain text only.`;
        const text = await callGemini(prompt, false);
        sendResponse({ success: true, data: { recap: text } });
        return;
      }

      if (message.action === 'FETCH_QUIZ') {
        await ensureGeminiKey();
        const { explanation, element_text } = message.payload;
        const prompt = `Generate 1 short multiple-choice comprehension question based on this UI explanation:
"${explanation}"
Element: "${element_text || 'Action'}"

Provide exactly 3 options. Return ONLY valid JSON:
{
  "question": "...",
  "options": ["Option A", "Option B", "Option C"],
  "correct_index": 0
}`;

        const text = await callGemini(prompt, true);
        const parsed = cleanAndParseJSON(text);
        sendResponse({ success: true, data: parsed });
        return;
      }

      if (message.action === 'TRIGGER_NEXT_STEP') {
        chrome.storage.local.get(['smart_cursor_tour_active', 'smart_cursor_tour_steps', 'smart_cursor_current_step_index'], (res) => {
          if (!res || !res.smart_cursor_tour_active || !Array.isArray(res.smart_cursor_tour_steps)) {
            sendResponse({ success: true });
            return;
          }

          const steps = res.smart_cursor_tour_steps;
          const currentIndex = typeof res.smart_cursor_current_step_index === 'number' ? res.smart_cursor_current_step_index : 0;
          const nextIndex = currentIndex + 1;

          if (nextIndex < steps.length) {
            chrome.storage.local.set({ smart_cursor_current_step_index: nextIndex });
            const step = steps[nextIndex];
            const sectionItems = Array.isArray(step.items) ? step.items : [];
            const sectionElementIds = sectionItems.map((item) => item.element_id).filter(Boolean);
            const firstElemId = sectionElementIds[0];

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'HIGHLIGHT_SECTION_ELEMENTS', element_ids: sectionElementIds });
                if (firstElemId) {
                  chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'GO_TO_ELEMENT',
                    element_id: firstElemId,
                    title: step.section_title || step.title,
                    explanation: step.section_summary || step.summary,
                    show_next_btn: true,
                  });
                }

                let narration = step.section_summary || step.summary || '';
                if (Array.isArray(step.capabilities) && step.capabilities.length > 0) {
                  narration += ' In this section, you can: ' + step.capabilities.join('. ') + '.';
                }
                chrome.tabs.sendMessage(tabs[0].id, { action: 'SPEAK', text: narration });
              }
            });
          } else {
            chrome.storage.local.set({ smart_cursor_tour_active: false });
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, { action: 'HIDE_OVERLAYS' });
                chrome.tabs.sendMessage(tabs[0].id, { action: 'SPEAK', text: 'Congratulations! You have completed the guided tour of this website.' });
              }
            });
          }

          sendResponse({ success: true });
        });
        return;
      }

      sendResponse({ success: false, error: 'unsupported_action', message: 'Unsupported action.' });
      return;
    } catch (error) {
      if (error.message === 'gemini_key_missing') {
        sendResponse({ success: false, error: 'gemini_key_missing', message: GEMINI_KEY_HELP });
        return;
      }

      console.error('Smart Cursor background error:', error);
      sendResponse({ success: false, error: error.message || 'Request failed.', message: 'Something went wrong. Please try again.' });
    }
  })();

  return true;
});
