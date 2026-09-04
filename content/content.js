/**
 * Smart Cursor - Content Script
 * Injected into host webpage to scan DOM, render animated cursor, element highlights, and tooltips.
 */

(() => {
  // In-memory mapping of element_id -> DOM Node
  const elementMap = new Map();
  let cursorEl = null;
  let tooltipEl = null;
  let changeToastEl = null;
  let currentHighlightedEl = null;
  let isExtensionEnabled = true;
  let isVoiceEnabled = true;
  let isReactiveMode = false;
  let audioElement = null;
  let tourHasRun = false;
  let domObserver = null;
  let lastUrl = window.location.href;

  // Restore saved state from storage immediately on injection
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['smart_cursor_power', 'smart_cursor_voice', 'smart_cursor_reactive'], (res) => {
        if (res) {
          if (typeof res.smart_cursor_power === 'boolean') isExtensionEnabled = res.smart_cursor_power;
          if (typeof res.smart_cursor_voice === 'boolean') isVoiceEnabled = res.smart_cursor_voice;
          if (typeof res.smart_cursor_reactive === 'boolean') isReactiveMode = res.smart_cursor_reactive;
        }
      });
    }
  } catch (e) { }

  // Safe messaging wrapper to catch Extension Context Invalidated errors silently
  function safeSendMessage(msg, callback) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return;
        if (callback) callback(res);
      });
    } catch (e) {
      // Extension reloaded — context invalidated
    }
  }

  // Initialize UI containers
  function ensureUI() {
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.id = 'smart-cursor-pointer';
      cursorEl.innerHTML = `
        <svg viewBox="0 0 24 24" width="52" height="52" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 3L11.5 21L14.5 13.5L22 10.5L4 3Z" fill="#2563EB" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/>
          <circle cx="14.5" cy="13.5" r="3.5" fill="#60A5FA" opacity="0.9"/>
        </svg>
        <span class="smart-cursor-halo"></span>
      `;
      document.body.appendChild(cursorEl);
    }

    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.id = 'smart-cursor-tooltip';
      tooltipEl.innerHTML = `
        <div class="smart-cursor-tooltip-header">
          <span class="smart-cursor-badge">Smart Guide</span>
          <button class="smart-cursor-close-btn" aria-label="Close">&times;</button>
        </div>
        <div class="smart-cursor-tooltip-title"></div>
        <div class="smart-cursor-tooltip-body"></div>
        <div class="smart-cursor-risk-warning" style="display:none;">
          <span>⚠️</span>
          <div class="smart-cursor-risk-copy">
            <span class="smart-cursor-risk-text"></span>
            <span class="smart-cursor-risk-reassurance">There's no rush — you can look around before deciding.</span>
          </div>
        </div>
        <div class="smart-cursor-tooltip-footer" style="margin-top:10px; display:flex; justify-content:flex-end;">
          <button class="smart-cursor-next-btn" style="display:none; background:#2563EB; color:#FFF; border:none; padding:6px 14px; border-radius:6px; font-weight:600; font-size:12px; cursor:pointer;">Next Section →</button>
        </div>
      `;
      document.body.appendChild(tooltipEl);

      tooltipEl.querySelector('.smart-cursor-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        hideTooltipAndCursor();
      });

      tooltipEl.querySelector('.smart-cursor-next-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        safeSendMessage({ action: 'TRIGGER_NEXT_STEP' });
      });
    }

    if (!audioElement) {
      audioElement = document.createElement('audio');
      audioElement.id = 'smart-cursor-audio';
      document.body.appendChild(audioElement);

      audioElement.addEventListener('ended', () => {
        safeSendMessage({ action: 'AUDIO_STATE_CHANGED', state: 'ended' });
      });
      audioElement.addEventListener('pause', () => {
        safeSendMessage({ action: 'AUDIO_STATE_CHANGED', state: 'paused' });
      });
      audioElement.addEventListener('play', () => {
        safeSendMessage({ action: 'AUDIO_STATE_CHANGED', state: 'playing' });
      });
    }

    if (!changeToastEl) {
      changeToastEl = document.createElement('div');
      changeToastEl.id = 'smart-cursor-change-toast';
      changeToastEl.innerHTML = `
        <span class="smart-cursor-toast-icon">✨</span>
        <span class="smart-cursor-toast-text">Page changed — Rescan tour?</span>
        <button class="smart-cursor-toast-btn" id="smart-cursor-toast-rescan">Rescan</button>
        <button class="smart-cursor-toast-close" id="smart-cursor-toast-dismiss">&times;</button>
      `;
      document.body.appendChild(changeToastEl);

      document.getElementById('smart-cursor-toast-rescan')?.addEventListener('click', () => {
        hideChangeToast();
        safeSendMessage({ action: 'TRIGGER_RESCAN' });
      });

      document.getElementById('smart-cursor-toast-dismiss')?.addEventListener('click', () => {
        hideChangeToast();
      });
    }
  }

  function showChangeToast() {
    ensureUI();
    if (changeToastEl && tourHasRun) {
      changeToastEl.classList.add('visible');
    }
  }

  function hideChangeToast() {
    if (changeToastEl) {
      changeToastEl.classList.remove('visible');
    }
  }

  // Monitor SPA navigation and DOM changes
  function setupPageChangeObserver() {
    if (domObserver) return;

    // Listen for SPA navigation events
    window.addEventListener('popstate', handleNavigationChange);

    // Monkey patch pushState and replaceState for SPA routers
    const origPushState = history.pushState;
    if (origPushState) {
      history.pushState = function (...args) {
        origPushState.apply(this, args);
        handleNavigationChange();
      };
    }

    const origReplaceState = history.replaceState;
    if (origReplaceState) {
      history.replaceState = function (...args) {
        origReplaceState.apply(this, args);
        handleNavigationChange();
      };
    }

    // Debounced MutationObserver for major dynamic container alterations
    let mutationTimeout = null;
    domObserver = new MutationObserver((mutations) => {
      if (!tourHasRun) return;

      let meaningfulChange = false;
      for (const m of mutations) {
        if (m.target && m.target.id && typeof m.target.id === 'string' && m.target.id.startsWith('smart-cursor-')) {
          continue;
        }
        if (m.addedNodes.length > 3 || m.removedNodes.length > 3) {
          meaningfulChange = true;
          break;
        }
      }

      if (meaningfulChange) {
        clearTimeout(mutationTimeout);
        mutationTimeout = setTimeout(() => {
          showChangeToast();
        }, 1200);
      }
    });

    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  function handleNavigationChange() {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      if (tourHasRun) {
        showChangeToast();
      }
    }
  }

  // Determine element type
  function getElementType(el) {
    const tagName = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName) || el.getAttribute('role') === 'heading') return 'heading';
    if (tagName === 'button' || el.getAttribute('role') === 'button' || el.type === 'button' || el.type === 'submit') return 'button';
    if (tagName === 'a' || el.getAttribute('role') === 'link') return 'link';
    if (tagName === 'select') return 'select';
    if (tagName === 'input') {
      if (el.type === 'checkbox' || el.getAttribute('role') === 'checkbox') return 'checkbox';
      if (el.type === 'radio' || el.getAttribute('role') === 'radio') return 'checkbox';
      return 'input';
    }
    if (tagName === 'textarea') return 'input';
    return 'text';
  }

  // Find associated label text for an interactive form field
  function getAssociatedLabelText(el) {
    // 1. Check aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        const txt = (labelEl.innerText || labelEl.textContent || '').trim();
        if (txt) return txt;
      }
    }

    // 2. Check <label for="el.id">
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) {
        const txt = (labelEl.innerText || labelEl.textContent || '').trim();
        if (txt) return txt;
      }
    }

    // 3. Check wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Clone label and remove interactive inputs from clone to get pure label text
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(n => n.remove());
      const txt = (clone.textContent || '').trim();
      if (txt) return txt;
    }

    return '';
  }

  // Find the closest preceding heading, legend, or section title for context
  function findNearbyHeading(el) {
    // 1. Check if inside fieldset with legend
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) {
        const txt = (legend.innerText || legend.textContent || '').trim().replace(/\s+/g, ' ');
        if (txt) return txt.slice(0, 80);
      }
    }

    // 2. Check aria-label / aria-labelledby on nearest container section/form
    const parentSection = el.closest('section, form, [role="region"], [role="group"], [role="tabpanel"], article, div[aria-label]');
    if (parentSection) {
      const sectionAria = parentSection.getAttribute('aria-label');
      if (sectionAria && sectionAria.trim()) {
        return sectionAria.trim().slice(0, 80);
      }
      const sectionLabelledBy = parentSection.getAttribute('aria-labelledby');
      if (sectionLabelledBy) {
        const headingNode = document.getElementById(sectionLabelledBy);
        if (headingNode) {
          const txt = (headingNode.innerText || headingNode.textContent || '').trim().replace(/\s+/g, ' ');
          if (txt) return txt.slice(0, 80);
        }
      }
    }

    // 3. Walk up the DOM tree and check preceding siblings or ancestor preceding siblings for headings
    let current = el;
    let depth = 0;
    while (current && current !== document.body && depth < 6) {
      // Check previous siblings of current node
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (/^h[1-6]$/i.test(sibling.tagName) || sibling.getAttribute('role') === 'heading') {
          const txt = (sibling.innerText || sibling.textContent || '').trim().replace(/\s+/g, ' ');
          if (txt) return txt.slice(0, 80);
        }
        // Also check if sibling contains a heading
        const nestedHeading = sibling.querySelector?.('h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (nestedHeading) {
          const txt = (nestedHeading.innerText || nestedHeading.textContent || '').trim().replace(/\s+/g, ' ');
          if (txt) return txt.slice(0, 80);
        }
        sibling = sibling.previousElementSibling;
      }

      current = current.parentElement;
      depth++;
    }

    // 4. Fallback: check document's first h1/h2 if in main flow
    return '';
  }

  // Clean visible text extractor for individual leaf/interactive elements
  function getCleanText(el) {
    const tag = el.tagName.toLowerCase();

    if (tag === 'input' || tag === 'textarea') {
      const labelText = getAssociatedLabelText(el);
      const placeholder = (el.placeholder || '').trim();
      const val = (el.value || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();

      if (labelText) {
        if (placeholder && placeholder !== labelText) {
          return `${labelText} (${placeholder})`;
        }
        return labelText;
      }
      return placeholder || aria || val || el.getAttribute('name') || 'Input field';
    }

    if (tag === 'select') {
      const labelText = getAssociatedLabelText(el);
      const selected = el.options && el.options[el.selectedIndex];
      const optText = (selected ? selected.text : '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();

      if (labelText) {
        return optText ? `${labelText}: ${optText}` : labelText;
      }
      return optText || aria || 'Dropdown select';
    }

    if (tag === 'button' || el.getAttribute('role') === 'button') {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title');
      const inner = (el.innerText || el.textContent || '').trim();
      return (aria || inner || el.value || 'Button').replace(/\s+/g, ' ');
    }

    if (tag === 'a' || el.getAttribute('role') === 'link') {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title');
      const inner = (el.innerText || el.textContent || '').trim();
      return (aria || inner || 'Link').replace(/\s+/g, ' ');
    }

    // For headings and standalone text leaves
    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    return text.replace(/\s+/g, ' ');
  }

  // Check if element is visible on screen
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getLandmarkSection(el) {
    if (!el) return 'Page Body';
    const navNode = el.closest('nav, header, [role="navigation"], [role="banner"]');
    if (navNode) return 'Header Navigation';
    const mainNode = el.closest('main, article, [role="main"], .hero, #hero, .banner');
    if (mainNode) return 'Main Hero Section';
    const formNode = el.closest('form, [role="form"]');
    if (formNode) return 'Interactive Form';
    const asideNode = el.closest('aside, [role="complementary"]');
    if (asideNode) return 'Sidebar';
    const footerNode = el.closest('footer, [role="contentinfo"]');
    if (footerNode) return 'Footer';
    return 'Page Body';
  }

  function isPrimaryCTA(el, landmark, text) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    const className = (el.className || '').toString().toLowerCase();
    const isCtaClass = /primary|cta|btn-main|btn-hero|submit|apply|get-started|start|action|register|login|signup/.test(className);
    if (isCtaClass) return true;
    if ((tag === 'button' || tag === 'a') && landmark === 'Main Hero Section') return true;
    if (tag === 'input' && (el.type === 'submit' || el.type === 'button')) return true;
    return false;
  }

  // Scan page DOM with strict leaf/interactive filtering and nearby heading extraction
  function scanPage() {
    // 1. Clean up old IDs before new scan
    document.querySelectorAll('[data-smart-cursor-id]').forEach((node) => {
      node.removeAttribute('data-smart-cursor-id');
    });

    elementMap.clear();
    ensureUI();
    setupPageChangeObserver();
    tourHasRun = true;
    hideChangeToast();

    const ignoredTags = new Set(['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link', 'br', 'hr', 'iframe']);

    // ONLY target real interactive elements, headings, and leaf paragraph text — NEVER structural containers
    const candidateNodes = Array.from(
      document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="switch"], p, [role="alert"]')
    );

    const elements = [];
    let counter = 1;

    for (const node of candidateNodes) {
      if (elements.length >= 140) break;

      const tag = node.tagName.toLowerCase();
      if (ignoredTags.has(tag)) continue;
      if (node.closest('#smart-cursor-pointer') || node.closest('#smart-cursor-tooltip') || node.closest('#smart-cursor-change-toast')) continue;
      if (!isVisible(node)) continue;

      // CRITICAL GUARD: Never treat nodes with interactive children as scannable leaf elements
      const hasInteractiveChildren = node.querySelectorAll('input, select, textarea, button, a, [role="button"], [role="link"]').length > 0;
      if (hasInteractiveChildren && tag !== 'button' && tag !== 'a') {
        continue;
      }

      // Skip standalone labels: their text is attached directly to inputs
      if (tag === 'label') continue;

      // For paragraph or alert text, ensure it is a true leaf text node
      const type = getElementType(node);
      if (type === 'text') {
        if (node.children.length > 0) continue; // Not a leaf
        const rawTxt = (node.innerText || node.textContent || '').trim();
        if (rawTxt.length < 8 || rawTxt.length > 300) continue; // Filter out tiny fragments or massive blocks
      }

      const text = getCleanText(node);
      if (!text || text.length < 2 || text.length > 250) continue;

      const nearbyHeading = findNearbyHeading(node);
      const landmark = getLandmarkSection(node);
      const primaryCta = isPrimaryCTA(node, landmark, text);

      // Estimate position on page
      const rect = node.getBoundingClientRect();
      const pageHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 1);
      const topRatio = (rect.top + window.scrollY) / pageHeight;
      let positionHint = 'middle of page';
      if (topRatio < 0.25) positionHint = 'top section / header';
      else if (topRatio > 0.75) positionHint = 'bottom section / footer';

      const id = `el-${counter++}`;
      elementMap.set(id, node);
      node.setAttribute('data-smart-cursor-id', id);

      elements.push({
        id,
        type,
        text: text.slice(0, 150),
        position_hint: positionHint,
        landmark_section: landmark,
        is_primary_cta: primaryCta,
        nearby_heading: nearbyHeading || undefined,
      });
    }

    return {
      page_url: window.location.href,
      page_title: document.title || 'Webpage',
      elements
    };
  }

  // Keep the cursor and highlight aligned even when the original element has changed or moved.
  function goToElement(elementId, title, explanation, onArrivalComplete) {
    ensureUI();
    const targetNode = elementMap.get(elementId) || document.querySelector(`[data-smart-cursor-id="${elementId}"]`);

    if (!targetNode || !document.body.contains(targetNode) || !isVisible(targetNode)) {
      console.warn('[Smart Cursor] Target element not found for id:', elementId);
      hideTooltipAndCursor();
      return false; // Return false to indicate element is missing
    }

    // Scroll element into view smoothly if off-screen
    targetNode.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

    // Wait slightly for scroll settling
    setTimeout(() => {
      const rect = targetNode.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      const targetX = rect.left + scrollX + Math.min(24, rect.width / 2);
      const targetY = rect.top + scrollY + Math.min(24, rect.height / 2);

      // Show and animate cursor
      cursorEl.style.display = 'block';
      cursorEl.style.opacity = '1';
      cursorEl.style.transform = 'scale(1.2)';
      cursorEl.style.left = `${targetX}px`;
      cursorEl.style.top = `${targetY}px`;

      // Clear previous highlight
      if (currentHighlightedEl) {
        currentHighlightedEl.classList.remove('smart-cursor-highlighted');
      }

      setTimeout(() => {
        cursorEl.style.transform = 'scale(1)';
        targetNode.classList.add('smart-cursor-highlighted');
        currentHighlightedEl = targetNode;

        // Position tooltip with loading state or content
        positionTooltip(rect, scrollX, scrollY, title, explanation, false, '');

        if (typeof onArrivalComplete === 'function') {
          onArrivalComplete();
        }
      }, 340);
    }, 120);

    return true;
  }

  // Position tooltip safely near target
  function positionTooltip(rect, scrollX, scrollY, title, explanation, isRisky, riskNote, showNextBtn) {
    if (!tooltipEl) return;

    tooltipEl.querySelector('.smart-cursor-tooltip-title').textContent = title || 'Element Focus';
    tooltipEl.querySelector('.smart-cursor-tooltip-body').textContent = explanation || 'Thinking...';

    const nextBtnEl = tooltipEl.querySelector('.smart-cursor-next-btn');
    if (nextBtnEl) {
      nextBtnEl.style.display = showNextBtn ? 'inline-block' : 'none';
    }

    const riskEl = tooltipEl.querySelector('.smart-cursor-risk-warning');
    const riskTextEl = tooltipEl.querySelector('.smart-cursor-risk-text');
    const reassuranceEl = tooltipEl.querySelector('.smart-cursor-risk-reassurance');
    if (riskEl && riskTextEl) {
      if (isRisky && riskNote) {
        riskTextEl.textContent = riskNote;
        if (reassuranceEl) reassuranceEl.textContent = "There's no rush — you can look around before deciding.";
        riskEl.style.display = 'flex';
      } else {
        if (reassuranceEl) reassuranceEl.textContent = "There's no rush — you can look around before deciding.";
        riskEl.style.display = 'none';
      }
    }

    tooltipEl.style.display = 'block';
    tooltipEl.style.opacity = '0';

    requestAnimationFrame(() => {
      const tooltipWidth = tooltipEl.offsetWidth || 300;
      const tooltipHeight = tooltipEl.offsetHeight || 120;
      const viewportWidth = window.innerWidth;

      let top = rect.bottom + scrollY + 12;
      let left = rect.left + scrollX;

      // Adjust if overflows bottom
      if (rect.bottom + tooltipHeight + 20 > window.innerHeight) {
        top = Math.max(10, rect.top + scrollY - tooltipHeight - 12);
      }

      // Adjust if overflows right
      if (left + tooltipWidth > scrollX + viewportWidth - 20) {
        left = Math.max(10, scrollX + viewportWidth - tooltipWidth - 20);
      }

      tooltipEl.style.top = `${top}px`;
      tooltipEl.style.left = `${left}px`;
      tooltipEl.style.opacity = '1';
    });
  }

  function clearSectionHighlights() {
    document.querySelectorAll('.smart-cursor-section-element').forEach((el) => {
      el.classList.remove('smart-cursor-section-element');
    });
  }

  function highlightSectionElements(elementIds) {
    clearSectionHighlights();
    if (!Array.isArray(elementIds)) return;

    elementIds.forEach((id) => {
      const node = elementMap.get(id) || document.querySelector(`[data-smart-cursor-id="${id}"]`);
      if (node && isVisible(node)) {
        node.classList.add('smart-cursor-section-element');
      }
    });
  }

  function hideTooltipAndCursor() {
    if (cursorEl) cursorEl.style.display = 'none';
    if (tooltipEl) tooltipEl.style.display = 'none';
    if (currentHighlightedEl) {
      currentHighlightedEl.classList.remove('smart-cursor-highlighted');
      currentHighlightedEl = null;
    }
    clearSectionHighlights();
  }

  // Play audio TTS or toggle play/pause state
  function playAudio(audioBase64) {
    if (!audioElement) ensureUI();
    if (!audioBase64 || !audioElement) return;

    try {
      audioElement.src = `data:audio/mp3;base64,${audioBase64}`;
      audioElement.play().catch(() => {});
    } catch (err) {
      console.error('[Smart Cursor] Audio playback failed:', err);
    }
  }

  function toggleAudioPlayback() {
    if (!audioElement) return;
    if (!audioElement.paused && !audioElement.ended) {
      audioElement.pause();
      return 'paused';
    } else if (audioElement.src) {
      audioElement.play().catch(() => { });
      return 'playing';
    }
    return 'none';
  }

  // ── Web Page Speech Synthesis (TTS) ──────────────────────────────────────────
  // Running in webpage context ensures audio continues even when extension popup closes.

  function getBestNaturalVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    // Prioritize natural, human-sounding online/premium voices
    const naturalOnline = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Online')));
    if (naturalOnline) return naturalOnline;

    const googleVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google'));
    if (googleVoice) return googleVoice;

    const premiumOS = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Premium') || v.name.includes('Enhanced') || v.name.includes('Samantha') || v.name.includes('Alex') || v.name.includes('Aria') || v.name.includes('Jenny')));
    if (premiumOS) return premiumOS;

    const usEnglish = voices.find(v => v.lang === 'en-US');
    if (usEnglish) return usEnglish;

    return voices.find(v => v.lang.startsWith('en')) || null;
  }

  function stopSpeech() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function speakText(text) {
    if (!isVoiceEnabled || !text || !window.speechSynthesis) return;
    stopSpeech();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 0.95;
    utt.pitch = 1.0;
    const bestVoice = getBestNaturalVoice();
    if (bestVoice) utt.voice = bestVoice;
    window.speechSynthesis.speak(utt);
  }

  // Pre-warm voice list
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
  }

  // Reactive Mode Click Listener (Only active when Point & Explain is ON)
  document.addEventListener('click', (e) => {
    if (!isExtensionEnabled || !isReactiveMode) return;

    // Ignore clicks inside our own overlays
    if (e.target.closest('#smart-cursor-pointer') || e.target.closest('#smart-cursor-tooltip') || e.target.closest('#smart-cursor-change-toast')) {
      return;
    }

    let target = e.target;
    let foundId = null;

    // Check if target or parent has a pre-scanned ID
    let current = target;
    while (current && current !== document.body) {
      const id = current.getAttribute('data-smart-cursor-id');
      if (id && elementMap.has(id)) {
        foundId = id;
        target = current;
        break;
      }
      current = current.parentElement;
    }

    // Dynamic registration fallback: if clicked item was not pre-scanned, register on-the-fly
    if (!foundId && target && target !== document.body) {
      const tag = target.tagName.toLowerCase();
      const isCandidate = ['button', 'a', 'input', 'select', 'textarea', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) ||
        target.getAttribute('role') || target.onclick || target.getAttribute('tabindex');
      if (isCandidate) {
        const text = getCleanText(target);
        if (text && text.length >= 2) {
          foundId = `el-dyn-${Math.random().toString(36).substr(2, 6)}`;
          elementMap.set(foundId, target);
          target.setAttribute('data-smart-cursor-id', foundId);
        }
      }
    }

    if (foundId && elementMap.has(foundId)) {
      e.preventDefault();
      e.stopPropagation();

      const type = getElementType(target);
      const text = getCleanText(target);

      goToElement(foundId, text, 'Thinking...', () => {
        safeSendMessage({
          action: 'FETCH_EXPLAIN',
          payload: {
            element_type: type,
            element_text: text,
            page_context: document.title,
            familiarity: 'beginner'
          }
        }, (response) => {
          if (response && response.success && response.data) {
            positionTooltip(target.getBoundingClientRect(), window.scrollX, window.scrollY, text, response.data.explanation);
            speakText(response.data.explanation);
          }
        });
      });
    }
  }, true);

  // Message Handler for Extension Communication
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // PING — lets popup.js check if content script is alive before injecting
    if (message.action === 'PING') {
      sendResponse({ alive: true });
      return true;
    }

    if (message.action === 'SCAN_PAGE') {
      const data = scanPage();
      sendResponse({ success: true, data });
      return true;
    }

    if (message.action === 'SPEAK') {
      speakText(message.text);
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'STOP_SPEECH') {
      stopSpeech();
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'SET_VOICE_ENABLED') {
      isVoiceEnabled = !!message.enabled;
      if (!isVoiceEnabled) stopSpeech();
      sendResponse({ success: true, isVoiceEnabled });
      return true;
    }

    if (message.action === 'DISABLE_EXTENSION') {
      isExtensionEnabled = false;
      isReactiveMode = false;
      stopSpeech();
      hideTooltipAndCursor();
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'HIGHLIGHT_SECTION_ELEMENTS') {
      highlightSectionElements(message.element_ids);
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'GO_TO_ELEMENT') {
      const success = goToElement(
        message.element_id,
        message.title,
        message.explanation,
        () => {
          safeSendMessage({ action: 'ARRIVAL_COMPLETE', element_id: message.element_id });
          // Also refresh tooltip with risk note if provided
          const targetNode = elementMap.get(message.element_id) || document.querySelector(`[data-smart-cursor-id="${message.element_id}"]`);
          if (targetNode && tooltipEl) {
            const rect = targetNode.getBoundingClientRect();
            positionTooltip(rect, window.scrollX, window.scrollY, message.title, message.explanation, message.is_risky, message.risk_note, !!message.show_next_btn);
          }
          if (message.speak_text) {
            speakText(message.speak_text);
          }
        }
      );
      sendResponse({ success, reason: success ? null : 'element_not_found' });
      return true;
    }

    if (message.action === 'SET_REACTIVE_MODE') {
      isReactiveMode = !!message.enabled;
      if (isReactiveMode && elementMap.size === 0) {
        scanPage();
      }
      sendResponse({ success: true, isReactiveMode });
      return true;
    }

    if (message.action === 'PLAY_AUDIO') {
      playAudio(message.audio_base64);
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'TOGGLE_AUDIO') {
      const state = toggleAudioPlayback();
      sendResponse({ success: true, state });
      return true;
    }

    if (message.action === 'HIDE_OVERLAYS') {
      stopSpeech();
      hideTooltipAndCursor();
      sendResponse({ success: true });
      return true;
    }
  });

})();

