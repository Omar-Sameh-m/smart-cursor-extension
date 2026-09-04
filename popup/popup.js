/**
 * Smart Cursor - Popup Script (Elder-First Rebuild)
 */
document.addEventListener('DOMContentLoaded', () => {
  // ── State ─────────────────────────────────────────────────────────────────
  let familiarity = 'beginner';
  let tourSteps = [], currentStepIndex = 0;
  let voiceEnabled = true, isReactiveMode = false;
  let scannedElements = [], pageTitle = '';
  let autoAdvanceTimer = null;
  let isAccessibilityMode = false;
  let speakingRate = 0.93;
  let currentStepAudioBase64 = '';
  let currentAudioText = '';
  let revealTimers = [];
  // Per-step sync state
  let stepArrived = false, stepExplainData = null;

  const RELAY_BASE_URL = 'http://localhost:3000';
  const DEFAULT_SPEAKING_RATE = 0.93;
  const ACCESSIBILITY_SPEAKING_RATE = 0.85;

  // ── Element Refs ──────────────────────────────────────────────────────────
  const viewFamiliarity = document.getElementById('view-familiarity');
  const viewLoading     = document.getElementById('view-loading');
  const viewTour        = document.getElementById('view-tour');
  const viewError       = document.getElementById('view-error');
  const loadingText     = document.getElementById('loading-text');
  const errorMessage    = document.getElementById('error-message');
  const inputAskQuestion  = document.getElementById('input-ask-question');
  const btnAskSubmit      = document.getElementById('btn-ask-submit');
  const askResultBox      = document.getElementById('ask-result-box');
  const askResultText     = document.getElementById('ask-result-text');
  const btnStartTour      = document.getElementById('btn-start-tour');
  const btnOrientation    = document.getElementById('btn-orientation');
  const orientationResult = document.getElementById('orientation-result');
  const orientationText   = document.getElementById('orientation-text');
  const chkReactiveMode   = document.getElementById('chk-reactive-mode');
  const toggleVoiceBtn    = document.getElementById('toggle-voice-btn');
  const tourStepCounter   = document.getElementById('tour-step-counter');
  const tourProgressFill  = document.getElementById('tour-progress-fill');
  const stepTitle         = document.getElementById('step-title');
  const stepExplanation   = document.getElementById('step-explanation');
  const missingBanner     = document.getElementById('missing-element-banner');
  const riskBanner        = document.getElementById('risk-warning-banner');
  const riskText          = document.getElementById('risk-warning-text');
  const jargonContainer   = document.getElementById('jargon-terms-container');
  const capabilitiesContainer = document.getElementById('capabilities-container');
  const capabilitiesList      = document.getElementById('capabilities-list');
  const interactiveHintBadge  = document.getElementById('interactive-hint-badge');
  const btnPrevStep       = document.getElementById('btn-prev-step');
  const btnNextStep       = document.getElementById('btn-next-step');
  const btnReplayAudio    = document.getElementById('btn-replay-audio');
  const audioBtnLabel     = document.getElementById('audio-btn-label');
  const iconAudioPlay     = document.getElementById('icon-audio-play');
  const iconAudioPause    = document.getElementById('icon-audio-pause');
  const btnStopTour       = document.getElementById('btn-stop-tour');
  const tourCompletionCard = document.getElementById('tour-completion-card');
  const tourRecapText     = document.getElementById('tour-recap-text');
  const tourStepsList     = document.getElementById('tour-steps-list');
  const btnRetry          = document.getElementById('btn-retry');

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showView(v) {
    [viewFamiliarity, viewLoading, viewTour, viewError].forEach(x => x.classList.remove('active'));
    v.classList.add('active');
  }

  // Ensure the content script is running in the active tab.
  // On tabs that existed before the extension was loaded, Chrome does NOT
  // auto-inject content scripts — we inject programmatically as a fallback.
  function ensureContentScript(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { cb(false); return; }

      // Blocked pages (Chrome internals, extension pages, etc.) cannot have scripts
      const url = tab.url || '';
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
          url.startsWith('about:') || url === '' || url.startsWith('edge://')) {
        cb(false, 'Smart Cursor cannot run on this type of page. Try navigating to a regular website first.');
        return;
      }

      // Ping to see if content script is already alive
      chrome.tabs.sendMessage(tab.id, { action: 'PING' }, (res) => {
        if (!chrome.runtime.lastError && res && res.alive) {
          cb(true); // Already injected
          return;
        }

        // Not alive — inject now
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content/content.js'] },
          () => {
            if (chrome.runtime.lastError) {
              cb(false, 'Could not inject Smart Cursor into this page. Try reloading the page.');
              return;
            }
            chrome.scripting.insertCSS(
              { target: { tabId: tab.id }, files: ['content/content.css'] },
              () => {
                // Give the script 350ms to initialise its listeners
                setTimeout(() => cb(true), 350);
              }
            );
          }
        );
      });
    });
  }

  function sendTab(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { if (cb) cb(null); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
        if (chrome.runtime.lastError) { if (cb) cb(null); } else { if (cb) cb(res); }
      });
    });
  }

  function sendBg(msg, cb) {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) { if (cb) cb(null); } else { if (cb) cb(res); }
    });
  }

  function showError(msg) { errorMessage.textContent = msg; showView(viewError); }

  // ── Ask Smart Cursor a Question ─────────────────────────────────────────
  function submitQuestion() {
    if (!inputAskQuestion) return;
    const qText = inputAskQuestion.value.trim();
    if (!qText) return;

    btnAskSubmit.disabled = true;
    btnAskSubmit.textContent = '...';
    askResultBox.style.display = 'none';

    const restoreAskBtn = () => {
      btnAskSubmit.disabled = false;
      btnAskSubmit.textContent = 'Ask';
    };

    ensureContentScript((ok, errMsg) => {
      if (!ok) {
        restoreAskBtn();
        askResultText.textContent = errMsg || "Couldn't reach this page. Try again on a regular website.";
        askResultBox.style.display = 'block';
        return;
      }

      sendTab({ action: 'SCAN_PAGE' }, (scanRes) => {
        if (!scanRes || !scanRes.success || !scanRes.data) {
          restoreAskBtn();
          askResultText.textContent = "Could not scan the page. Make sure the page is fully loaded, then try again.";
          askResultBox.style.display = 'block';
          return;
        }

        sendBg({
          action: 'ASK_QUESTION',
          payload: {
            question: qText,
            page_title: scanRes.data.page_title,
            page_url: scanRes.data.page_url,
            elements: scanRes.data.elements || []
          }
        }, (res) => {
          restoreAskBtn();
          const answer = (res && res.success && res.data && res.data.answer)
            ? res.data.answer
            : 'I could not find an answer for that on this page.';
          const targetId = (res && res.success && res.data && res.data.target_element_id) ? res.data.target_element_id : null;

          askResultText.textContent = answer;
          askResultBox.style.display = 'block';
          speak(answer);

          if (targetId) {
            sendTab({
              action: 'GO_TO_ELEMENT',
              element_id: targetId,
              title: '📍 Found here!',
              explanation: answer,
              speak_text: ''
            });
          }
        });
      });
    });
  }

  if (btnAskSubmit) btnAskSubmit.addEventListener('click', submitQuestion);
  if (inputAskQuestion) {
    inputAskQuestion.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitQuestion();
    });
  }

  const togglePowerBtn   = document.getElementById('toggle-power-btn');
  const powerStatusDot   = document.getElementById('power-status-dot');
  const powerStatusText  = document.getElementById('power-status-text');

  let isExtensionEnabled = true;

  // ── Master Power Switch (ON / OFF) ───────────────────────────────────────
  if (togglePowerBtn) {
    togglePowerBtn.addEventListener('click', () => {
      isExtensionEnabled = !isExtensionEnabled;
      togglePowerBtn.classList.toggle('active', isExtensionEnabled);
      togglePowerBtn.classList.toggle('off', !isExtensionEnabled);
      powerStatusDot.className = `status-dot ${isExtensionEnabled ? 'green' : 'red'}`;
      powerStatusText.textContent = isExtensionEnabled ? 'ON' : 'OFF';

      try { chrome.storage.local.set({ smart_cursor_power: isExtensionEnabled }); } catch(e) {}

      if (!isExtensionEnabled) {
        chkReactiveMode.checked = false;
        isReactiveMode = false;
        try { chrome.storage.local.set({ smart_cursor_reactive: false }); } catch(e) {}
        sendTab({ action: 'DISABLE_EXTENSION' });
        stopSpeech();
      } else {
        ensureContentScript(() => {});
      }
    });
  }

  // ── Voice / TTS ───────────────────────────────────────────────────────────
  toggleVoiceBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    toggleVoiceBtn.classList.toggle('active', voiceEnabled);
    try { chrome.storage.local.set({ smart_cursor_voice: voiceEnabled }); } catch(e) {}
    sendTab({ action: 'SET_VOICE_ENABLED', enabled: voiceEnabled });
    if (!voiceEnabled) stopSpeech();
  });

  function stopSpeech() {
    sendTab({ action: 'STOP_SPEECH' });
    updateAudioButtonState('idle');
  }

  function updateAudioButtonState(state) {
    const playing = state === 'playing';
    if (iconAudioPlay) iconAudioPlay.style.display = playing ? 'none' : 'block';
    if (iconAudioPause) iconAudioPause.style.display = playing ? 'block' : 'none';
    if (audioBtnLabel) {
      audioBtnLabel.textContent = playing ? 'Pause narration' : 'Play narration';
    }
  }

  function clearRevealTimers() {
    revealTimers.forEach((timer) => clearTimeout(timer));
    revealTimers = [];
  }

  function showAllRevealedContent() {
    if (capabilitiesContainer && capabilitiesList && capabilitiesList.children.length > 0) {
      capabilitiesContainer.style.display = 'block';
      capabilitiesContainer.classList.add('is-visible');
    }
    if (riskBanner && riskBanner.dataset && riskBanner.dataset.showRisk === 'true') {
      riskBanner.style.display = 'flex';
      riskBanner.classList.add('is-visible');
    }
  }

  function scheduleSectionReveal(step) {
    clearRevealTimers();
    const hasCapabilities = Array.isArray(step.capabilities) && step.capabilities.length > 0;
    const hasRisk = !!(step.is_risky && (step.section_risk_note || step.risk_note));

    if (capabilitiesContainer) {
      capabilitiesContainer.classList.remove('is-visible');
      capabilitiesContainer.style.display = 'none';
    }
    if (riskBanner) {
      riskBanner.dataset.showRisk = hasRisk ? 'true' : 'false';
      riskBanner.classList.remove('is-visible');
      riskBanner.style.display = 'none';
    }

    if (hasCapabilities) {
      const capTimer = setTimeout(() => {
        if (capabilitiesContainer) {
          capabilitiesContainer.style.display = 'block';
          requestAnimationFrame(() => capabilitiesContainer.classList.add('is-visible'));
        }
      }, 900);
      revealTimers.push(capTimer);
    }

    if (hasRisk) {
      const delay = hasCapabilities ? 1400 : 900;
      const riskTimer = setTimeout(() => {
        if (riskBanner) {
          riskBanner.style.display = 'flex';
          requestAnimationFrame(() => riskBanner.classList.add('is-visible'));
        }
      }, delay);
      revealTimers.push(riskTimer);
    }
  }

  async function speak(text) {
    if (!voiceEnabled || !text) return;
    const narration = text.trim();
    if (!narration) return;

    const isCurrentStepNarration = !!(stepExplainData && stepExplainData.explanation && narration === stepExplainData.explanation);

    if (isCurrentStepNarration && currentAudioText === narration && currentStepAudioBase64) {
      sendTab({ action: 'PLAY_AUDIO', audio_base64: currentStepAudioBase64 }, () => {
        updateAudioButtonState('playing');
      });
      return;
    }

    try {
      const effectiveRate = isAccessibilityMode
        ? ACCESSIBILITY_SPEAKING_RATE
        : (speakingRate || DEFAULT_SPEAKING_RATE);

      const res = await fetch(`${RELAY_BASE_URL}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: narration,
          speaking_rate: effectiveRate,
          is_accessibility_mode: isAccessibilityMode || false,
        }),
      });

      const payload = await res.json();
      const audioBase64 = payload && payload.audio_base64 ? payload.audio_base64 : null;

      if (audioBase64) {
        if (isCurrentStepNarration) {
          currentStepAudioBase64 = audioBase64;
          currentAudioText = narration;
        }
        sendTab({ action: 'PLAY_AUDIO', audio_base64: audioBase64 }, () => {
          updateAudioButtonState('playing');
        });
        return;
      }

      throw new Error(payload && payload.error ? payload.error : 'No Neural2 audio returned.');
    } catch (error) {
      currentStepAudioBase64 = '';
      currentAudioText = '';
      sendTab({ action: 'SPEAK', text: narration });
      console.warn('[Smart Cursor] Fallback to browser TTS for narration:', error);
    }
  }

  btnReplayAudio.addEventListener('click', () => {
    if (!stepExplainData) return;
    const narrationText = stepExplainData.explanation || '';
    if (!narrationText) return;

    if (currentStepAudioBase64 && currentAudioText === narrationText) {
      sendTab({ action: 'TOGGLE_AUDIO' }, (res) => {
        if (res && res.state) updateAudioButtonState(res.state);
      });
      return;
    }

    speak(narrationText);
  });

  // ── Orientation: "What page am I on?" ────────────────────────────────────
  btnOrientation.addEventListener('click', () => {
    btnOrientation.disabled = true;
    btnOrientation.innerHTML = '<span class="orientation-btn-icon">⏳</span><span class="orientation-btn-text">Thinking...</span>';
    orientationResult.style.display = 'none';

    const restoreBtn = () => {
      btnOrientation.disabled = false;
      btnOrientation.innerHTML = '<span class="orientation-btn-icon">🔍</span><span class="orientation-btn-text">What page am I on?</span>';
    };

    ensureContentScript((ok, errMsg) => {
      if (!ok) {
        restoreBtn();
        orientationText.textContent = errMsg || "Couldn't reach this page. Navigate to a regular website first.";
        orientationResult.style.display = 'block';
        return;
      }

      sendTab({ action: 'SCAN_PAGE' }, (scanRes) => {
        if (!scanRes || !scanRes.success || !scanRes.data) {
          restoreBtn();
          orientationText.textContent = "Couldn't read this page. Try navigating to a regular website first.";
          orientationResult.style.display = 'block';
          return;
        }

        sendBg({
          action: 'FETCH_ORIENTATION',
          payload: { page_title: scanRes.data.page_title, page_url: scanRes.data.page_url, elements: scanRes.data.elements || [] }
        }, (res) => {
          restoreBtn();
          const text = (res && res.success && res.data && res.data.orientation)
            ? res.data.orientation
            : 'This appears to be a standard web page. Try the guided tour for details.';
          orientationText.textContent = text;
          orientationResult.style.display = 'block';
          speak(text);
        });
      });
    });
  });

  // ── Reactive Mode ─────────────────────────────────────────────────────────
  chkReactiveMode.addEventListener('change', (e) => {
    isReactiveMode = e.target.checked;
    try { chrome.storage.local.set({ smart_cursor_reactive: isReactiveMode }); } catch(e) {}
    ensureContentScript((ok) => {
      if (ok) {
        sendTab({ action: 'SET_REACTIVE_MODE', enabled: isReactiveMode });
      }
    });
  });

  // ── Stop Tour ─────────────────────────────────────────────────────────────
  btnStopTour.addEventListener('click', () => {
    stopSpeech();
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    tourSteps = []; scannedElements = []; currentStepIndex = 0;
    stepArrived = false; stepExplainData = null;
    try {
      chrome.storage.local.set({
        smart_cursor_tour_active: false,
        smart_cursor_tour_steps: [],
        smart_cursor_current_step_index: 0
      });
    } catch(e) {}
    sendTab({ action: 'HIDE_OVERLAYS' });
    showView(viewFamiliarity);
  });

  // ── Start Tour ────────────────────────────────────────────────────────────
  btnStartTour.addEventListener('click', startTour);
  btnRetry.addEventListener('click', startTour);

  function startTour() {
    showView(viewLoading);
    loadingText.textContent = 'Checking page access...';
    if (missingBanner) missingBanner.style.display = 'none';
    if (tourCompletionCard) tourCompletionCard.style.display = 'none';
    stopSpeech();

    ensureContentScript((ok, errMsg) => {
      if (!ok) {
        showError(errMsg || 'Smart Cursor cannot access this page. Navigate to a regular website and try again.');
        return;
      }

      loadingText.textContent = 'Scanning page elements...';

      sendTab({ action: 'SCAN_PAGE' }, (scanRes) => {
        if (!scanRes || !scanRes.success || !scanRes.data) {
          showError('Could not scan the page. Try reloading the page, then click the extension again.'); return;
        }
        scannedElements = scanRes.data.elements || [];
        pageTitle = scanRes.data.page_title || 'Webpage';
        if (scannedElements.length === 0) {
          showError("This page can't be scanned. Try a regular website like a form, shopping page, or settings screen."); return;
        }

        loadingText.textContent = 'Gemini AI is building your guided tour...';

        sendBg({
          action: 'FETCH_TOUR',
          payload: { page_url: scanRes.data.page_url, page_title: pageTitle, elements: scannedElements }
        }, (tourRes) => {
          if (!tourRes || !tourRes.success || !tourRes.data) {
            showError(tourRes?.error || 'AI could not generate a tour. Please try again.'); return;
          }

          const sections = tourRes.data.tour || [];
          if (sections.length === 0) { showError('AI returned no sections for this page. Please retry.'); return; }

          tourSteps = sections;
          siteOrientation = tourRes.data.site_orientation || '';
          currentStepIndex = 0;
          try {
            chrome.storage.local.set({
              smart_cursor_tour_active: true,
              smart_cursor_tour_steps: tourSteps,
              smart_cursor_site_orientation: siteOrientation,
              smart_cursor_current_step_index: 0
            });
          } catch(e) {}
          renderStepsList();
          showView(viewTour);
          executeStep(0);
        });
      });
    });
  }

  // ── Render Steps Sidebar ──────────────────────────────────────────────────
  function renderStepsList() {
    tourStepsList.innerHTML = '';
    tourSteps.forEach((step, idx) => {
      const pill = document.createElement('div');
      pill.className = `step-item-pill${idx === currentStepIndex ? ' active' : ''}`;
      pill.innerHTML = `<span class="step-num">${idx+1}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${step.section_title || step.title || `Section ${idx+1}`}</span>`;
      pill.addEventListener('click', () => executeStep(idx));
      tourStepsList.appendChild(pill);
    });
  }

  // ── Execute Step ──────────────────────────────────────────────────────────
  function executeStep(index) {
    if (index < 0 || index >= tourSteps.length) return;
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    clearRevealTimers();

    stepArrived = false; stepExplainData = null;
    currentStepAudioBase64 = '';
    currentAudioText = '';
    stopSpeech();
    currentStepIndex = index;
    try {
      chrome.storage.local.set({ smart_cursor_current_step_index: index });
    } catch(e) {}

    const step = tourSteps[index]; // Step is a Section object
    const total = tourSteps.length;

    if (missingBanner) missingBanner.style.display = 'none';
    if (riskBanner) riskBanner.style.display = 'none';
    if (jargonContainer) { jargonContainer.style.display = 'none'; jargonContainer.innerHTML = ''; }
    if (tourCompletionCard) tourCompletionCard.style.display = 'none';

    tourStepCounter.textContent = `Section ${index + 1} of ${total}`;
    tourProgressFill.style.width = `${((index + 1) / total) * 100}%`;
    stepTitle.textContent = step.section_title || step.title || `Section ${index + 1}`;
    stepExplanation.textContent = step.section_summary || step.summary || 'Section overview...';
    stepExplanation.style.opacity = '1';
    btnPrevStep.disabled = (index === 0);
    btnNextStep.textContent = index === total - 1 ? '✓ Finish Tour' : 'Next →';

    tourStepsList.querySelectorAll('.step-item-pill').forEach((p, i) =>
      p.classList.toggle('active', i === index));

    // Render outcome capabilities bullets
    if (Array.isArray(step.capabilities) && step.capabilities.length > 0) {
      capabilitiesList.innerHTML = '';
      step.capabilities.forEach((cap) => {
        const li = document.createElement('li');
        li.textContent = cap;
        capabilitiesList.appendChild(li);
      });
      capabilitiesContainer.style.display = 'none';
      capabilitiesContainer.classList.remove('is-visible');
    } else {
      capabilitiesContainer.style.display = 'none';
      capabilitiesContainer.classList.remove('is-visible');
    }

    // Render section-level risk note
    if (step.is_risky && (step.section_risk_note || step.risk_note)) {
      riskText.textContent = step.section_risk_note || step.risk_note || 'Some actions in this section cannot be undone once confirmed.';
      riskBanner.style.display = 'none';
      riskBanner.classList.remove('is-visible');
    } else {
      riskBanner.style.display = 'none';
      riskBanner.classList.remove('is-visible');
    }

    scheduleSectionReveal(step);

    // Show interactive hint badge
    if (interactiveHintBadge) interactiveHintBadge.style.display = 'block';

    // Get element IDs belonging to this section
    const sectionItems = Array.isArray(step.items) ? step.items : [];
    const sectionElementIds = sectionItems.map((item) => item.element_id).filter(Boolean);

    // Visually outline all elements in this section as explorable
    sendTab({ action: 'HIGHLIGHT_SECTION_ELEMENTS', element_ids: sectionElementIds });

    // Focus cursor on the first element of the section if available
    const firstElemId = sectionElementIds[0];
    if (firstElemId) {
      sendTab({
        action: 'GO_TO_ELEMENT',
        element_id: firstElemId,
        title: step.section_title || step.title,
        explanation: step.section_summary || step.summary,
        show_next_btn: true
      });
    }

    // Build speech narration: site overview (section 1) + section summary + capabilities
    let narration = (index === 0 && siteOrientation) ? `${siteOrientation} ` : '';
    narration += step.section_summary || step.summary || '';
    if (Array.isArray(step.capabilities) && step.capabilities.length > 0) {
      narration += ' In this section, you can: ' + step.capabilities.join('. ') + '.';
    }

    stepExplainData = { explanation: narration };
    speak(narration);
  }

  // ── Jargon Pills ──────────────────────────────────────────────────────────
  function renderJargon(terms) {
    jargonContainer.innerHTML = '';
    let openBox = null;
    terms.forEach(({ term, definition }) => {
      const pill = document.createElement('button');
      pill.className = 'jargon-pill';
      pill.innerHTML = `${term} <span class="jargon-pill-arrow">▶</span>`;
      const box = document.createElement('div');
      box.className = 'jargon-definition-box';
      box.textContent = definition;
      box.style.display = 'none';
      pill.addEventListener('click', () => {
        if (openBox && openBox !== box) openBox.style.display = 'none';
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
        openBox = box.style.display === 'block' ? box : null;
        pill.querySelector('.jargon-pill-arrow').textContent = box.style.display === 'block' ? '▼' : '▶';
      });
      jargonContainer.appendChild(pill);
      jargonContainer.appendChild(box);
    });
    jargonContainer.style.display = 'flex';
  }

  // ── Next / Prev ───────────────────────────────────────────────────────────
  btnNextStep.addEventListener('click', () => {
    if (currentStepIndex < tourSteps.length - 1) {
      showAllRevealedContent();
      executeStep(currentStepIndex + 1);
    } else finishTour();
  });
  btnPrevStep.addEventListener('click', () => {
    if (currentStepIndex > 0) {
      showAllRevealedContent();
      executeStep(currentStepIndex - 1);
    }
  });

  function finishTour() {
    stepTitle.textContent = '🎉 Tour Complete!';
    stepExplanation.textContent = "You've seen all the key sections of this page. Well done!";
    if (capabilitiesContainer) capabilitiesContainer.style.display = 'none';
    if (interactiveHintBadge) interactiveHintBadge.style.display = 'none';
    if (riskBanner) riskBanner.style.display = 'none';
    if (jargonContainer) jargonContainer.style.display = 'none';
    if (tourCompletionCard) tourCompletionCard.style.display = 'block';
    stopSpeech();
    btnNextStep.textContent = '↺ Restart Tour';
    btnNextStep.onclick = () => { btnNextStep.onclick = null; executeStep(0); };

    sendBg({ action: 'FETCH_RECAP', payload: { tour_titles: tourSteps.map(s => s.section_title || s.title), page_title: pageTitle } }, (res) => {
      const recap = (res && res.success && res.data && res.data.recap)
        ? res.data.recap : `Great job! You've learned the key sections on ${pageTitle}.`;
      tourRecapText.textContent = recap;
      speak(recap);
    });
  }

  // ── ARRIVAL_COMPLETE ────────────────────────────────────────────────────────
  // Speech is now handled by content.js via speak_text in GO_TO_ELEMENT.
  // This listener is kept for potential future use (e.g. UI state updates).
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'ARRIVAL_COMPLETE') {
      const step = tourSteps[currentStepIndex];
      if (step && message.element_id === step.element_id) {
        stepArrived = true;
      }
    }
    if (message.action === 'AUDIO_STATE_CHANGED') {
      updateAudioButtonState(message.state || 'idle');
    }
    if (message.action === 'TRIGGER_RESCAN') startTour();
    if (message.action === 'TRIGGER_NEXT_STEP') {
      if (currentStepIndex < tourSteps.length - 1) {
        executeStep(currentStepIndex + 1);
      } else {
        showCompletionCard();
      }
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  try {
    chrome.storage.local.get([
      'smart_cursor_power',
      'smart_cursor_voice',
      'smart_cursor_reactive',
      'smart_cursor_accessibility_mode',
      'smart_cursor_speaking_rate',
      'smart_cursor_tour_active',
      'smart_cursor_tour_steps',
      'smart_cursor_site_orientation',
      'smart_cursor_current_step_index'
    ], (res) => {
      if (!res) return;
      if (typeof res.smart_cursor_power === 'boolean') {
        isExtensionEnabled = res.smart_cursor_power;
        if (togglePowerBtn) {
          togglePowerBtn.classList.toggle('active', isExtensionEnabled);
          togglePowerBtn.classList.toggle('off', !isExtensionEnabled);
          powerStatusDot.className = `status-dot ${isExtensionEnabled ? 'green' : 'red'}`;
          powerStatusText.textContent = isExtensionEnabled ? 'ON' : 'OFF';
        }
      }
      if (typeof res.smart_cursor_voice === 'boolean') {
        voiceEnabled = res.smart_cursor_voice;
        if (toggleVoiceBtn) toggleVoiceBtn.classList.toggle('active', voiceEnabled);
      }
      if (typeof res.smart_cursor_reactive === 'boolean') {
        isReactiveMode = res.smart_cursor_reactive;
        if (chkReactiveMode) chkReactiveMode.checked = isReactiveMode;
        if (isReactiveMode && isExtensionEnabled) {
          ensureContentScript((ok) => {
            if (ok) sendTab({ action: 'SET_REACTIVE_MODE', enabled: true });
          });
        }
      }
      if (typeof res.smart_cursor_accessibility_mode === 'boolean') {
        isAccessibilityMode = res.smart_cursor_accessibility_mode;
      }
      if (typeof res.smart_cursor_speaking_rate === 'number') {
        speakingRate = Math.max(0.5, Math.min(1.5, res.smart_cursor_speaking_rate));
      }
      // Restore active tour state across popup window closes
      if (res.smart_cursor_tour_active && Array.isArray(res.smart_cursor_tour_steps) && res.smart_cursor_tour_steps.length > 0) {
        tourSteps = res.smart_cursor_tour_steps;
        siteOrientation = res.smart_cursor_site_orientation || '';
        currentStepIndex = typeof res.smart_cursor_current_step_index === 'number' ? res.smart_cursor_current_step_index : 0;
        renderStepsList();
        showView(viewTour);
        executeStep(currentStepIndex);
      }
    });
  } catch(e) {}

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', () => window.speechSynthesis.getVoices());
  }
});
