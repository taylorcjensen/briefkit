(() => {
  function initializeUserRespond() {
    if (window.__briefkitResponseReady) return;
    window.__briefkitResponseReady = true;

    const forms = [...document.querySelectorAll('[data-bk-response-form]')];
    if (!forms.length) return;
    const meta = (name, doc = document) => doc.querySelector(`meta[name="${name}"]`)?.content;
    const version = meta('briefkit-response-version');
    const pageLinks = JSON.parse(meta('briefkit-response-pages') || '[]');
    const pageUrls = pageLinks.map((href) => new URL(href, window.location.href).href);
    const currentUrl = window.location.href;
    const currentPageUrl = currentUrl.split(/[?#]/)[0];
    const draftKey = version && pageUrls.length
      ? `briefkit-response:${pageUrls[0]}:${version}`
      : null;

    function readDraft() {
      if (!draftKey) return {};
      try {
        const value = JSON.parse(localStorage.getItem(draftKey) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch { return {}; }
    }

    function writeDraft(draft) {
      if (!draftKey) return;
      try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Storage may be disabled. */ }
    }

    function collectAnswers(form) {
      const answers = Object.create(null);
      for (const question of form.querySelectorAll('[data-bk-question-id]')) {
        const id = question.dataset.bkQuestionId;
        if (!id) continue;
        const type = question.dataset.bkQuestionType;
        if (type === 'checkbox') {
          answers[id] = question.querySelector('input[type="checkbox"]')?.checked ?? false;
        } else if (type === 'checkboxes') {
          answers[id] = [...question.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
        } else if (type === 'radio') {
          answers[id] = question.querySelector('input[type="radio"]:checked')?.value ?? '';
        } else {
          answers[id] = question.querySelector('input, select, textarea')?.value ?? '';
        }
      }
      return answers;
    }

    function restoreAnswers(form, answers) {
      if (!answers) return;
      for (const question of form.querySelectorAll('[data-bk-question-id]')) {
        const id = question.dataset.bkQuestionId;
        if (!Object.prototype.hasOwnProperty.call(answers, id)) continue;
        const value = answers[id];
        const type = question.dataset.bkQuestionType;
        if (type === 'checkbox') {
          const input = question.querySelector('input[type="checkbox"]');
          if (input) input.checked = value === true;
        } else if (type === 'checkboxes' || type === 'radio') {
          for (const input of question.querySelectorAll('input')) {
            input.checked = type === 'checkboxes' ? Array.isArray(value) && value.includes(input.value) : input.value === value;
          }
        } else {
          const input = question.querySelector('input, select, textarea');
          if (input && typeof value === 'string') input.value = value;
        }
      }
    }

    function updateRequiredGroups(form) {
      const groups = [...form.querySelectorAll('[data-bk-required-group]')];
      const names = new Set(groups.map((input) => input.name));
      for (const name of names) {
        const inputs = groups.filter((input) => input.name === name);
        inputs[0]?.setCustomValidity(inputs.some((input) => input.checked) ? '' : 'Select at least one option.');
      }
    }

    function saveCurrentPage() {
      const draft = readDraft();
      draft[currentPageUrl] = forms.map(collectAnswers);
      writeDraft(draft);
    }

    function isMissing(question, value) {
      if (question.dataset.bkQuestionRequired !== 'true') return false;
      if (question.dataset.bkQuestionType === 'checkbox') return value !== true;
      if (question.dataset.bkQuestionType === 'checkboxes') return !Array.isArray(value) || value.length === 0;
      return typeof value !== 'string' || value.length === 0;
    }

    async function gatherBrief() {
      saveCurrentPage();
      const draft = readDraft();
      const pages = pageUrls.length ? pageUrls : [currentPageUrl];
      const answers = Object.create(null);
      const seen = new Map();
      let missing;
      const allForms = [];
      let count = 0;
      for (const url of pages) {
        let pageForms;
        if (url === currentPageUrl) {
          pageForms = forms;
        } else {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Could not load response questions from ${url} (HTTP ${response.status}).`);
          const page = new DOMParser().parseFromString(await response.text(), 'text/html');
          pageForms = [...page.querySelectorAll('[data-bk-response-form]')];
          const remoteVersion = meta('briefkit-response-version', page);
          if (remoteVersion && remoteVersion !== version) {
            throw new Error('The brief changed since this page loaded. Reload before submitting.');
          }
          if (pageForms.length && remoteVersion !== version) {
            throw new Error(`Response questions on ${url} need the standard brief layout to join this submission.`);
          }
          pageForms.forEach((form, index) => restoreAnswers(form, draft[url]?.[index]));
        }
        for (const form of pageForms) {
          allForms.push(form);
          count += 1;
          const formAnswers = collectAnswers(form);
          for (const question of form.querySelectorAll('[data-bk-question-id]')) {
            const id = question.dataset.bkQuestionId;
            if (!id) continue;
            if (seen.has(id)) {
              throw new Error(`Question id "${id}" is used more than once in this brief. Give each question a unique id before submitting.`);
            }
            seen.set(id, url);
            if (!missing && isMissing(question, formAnswers[id])) {
              const label = question.querySelector('legend')?.textContent?.trim() || id;
              missing = `Answer required: ${label}. ${url === currentPageUrl ? '' : `Visit ${url} to answer it.`}`;
            }
            answers[id] = formAnswers[id];
          }
        }
      }
      if (missing) throw new Error(missing);
      return { answers, count, allForms };
    }

    function destination(allForms) {
      const explicit = allForms.filter((form) => form.dataset.bkResponseAction);
      const targets = new Set(explicit.map((form) => `${form.dataset.bkResponseAction}\n${form.dataset.bkResponseToken || ''}`));
      if (targets.size > 1) throw new Error('Response forms have conflicting webhook actions or tokens. Use one destination for the brief.');
      const selected = explicit[0];
      return selected
        ? { endpoint: selected.dataset.bkResponseAction, token: selected.dataset.bkResponseToken }
        : { endpoint: meta('briefkit-response-endpoint'), token: meta('briefkit-response-token') };
    }

    async function submitResponse(submission, allForms, status) {
      const { endpoint, token } = destination(allForms);
      if (!endpoint) {
        await navigator.clipboard.writeText(JSON.stringify(submission, null, 2));
        if (status) status.textContent = 'No callback is configured. The response JSON was copied to your clipboard.';
        return false;
      }
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(submission) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `Submission failed with HTTP ${response.status}`);
      forms.forEach((form) => form.querySelectorAll('input, select, textarea, button').forEach((control) => { control.disabled = true; }));
      if (draftKey) try { localStorage.removeItem(draftKey); } catch { /* Storage may be disabled. */ }
      if (status) status.textContent = 'Response submitted. You can return to the chat.';
      return true;
    }

    forms.forEach((form, index) => {
      if (!(form instanceof HTMLFormElement) || form.dataset.bkResponseReady === 'true') return;
      form.dataset.bkResponseReady = 'true';
      restoreAnswers(form, readDraft()[currentPageUrl]?.[index]);
      updateRequiredGroups(form);
      form.addEventListener('input', () => { updateRequiredGroups(form); saveCurrentPage(); });
      form.addEventListener('change', () => { updateRequiredGroups(form); saveCurrentPage(); });
      const status = form.querySelector('.bk-response-status');
      const button = form.querySelector('.bk-response-submit');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        updateRequiredGroups(form);
        if (!form.reportValidity()) return;
        if (button) button.disabled = true;
        if (status) status.textContent = 'Submitting…';
        try {
          const { answers, count, allForms } = await gatherBrief();
          const submission = {
            schemaVersion: 1,
            formId: count === 1 ? form.dataset.bkResponseId || 'response' : 'brief',
            answers,
            submittedAt: new Date().toISOString(),
            pageUrl: currentUrl,
          };
          const sent = await submitResponse(submission, allForms, status);
          if (!sent && button) button.disabled = false;
        } catch (error) {
          if (button) button.disabled = false;
          if (status) status.textContent = error instanceof Error ? error.message : 'Submission failed.';
        }
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeUserRespond);
  else initializeUserRespond();
})();
