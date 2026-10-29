export function initMail({ getState, setState, api, action, notice, activate, openAudit }) {
  const $ = (s) => document.querySelector(s),
    n = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== null && text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
  let selected = '',
    packetKey = '',
    packetDirty = false,
    packetRevision = 0,
    pendingFiles = [],
    replyId = null,
    replyRevision = 0,
    replyDirty = false;
  let emailDirty = false,
    emailJob = '',
    sending = false,
    reviewedPacket = '',
    reviewedReply = '';
  let preparation = null,
    preparationEpoch = 0,
    preparedReferences = null;
  const preparationStatus = (text) => {
    $('#prepare-status').textContent = text;
  };
  function invalidatePreparation(
    text = 'Preparation cancelled. Your existing packet is unchanged.',
  ) {
    preparationEpoch++;
    const active = preparation;
    preparation = null;
    if (active) {
      void api('/api/applications/' + active.job + '/prepare/cancel', {
        requestId: active.requestId,
      }).catch(() => {});
      preparationStatus(text);
    }
    $('#prepare-cancel').hidden = true;
    $('#prepare-packet').disabled = false;
  }
  function clearPreparationReferences() {
    preparedReferences = null;
    $('#prepare-provenance').hidden = true;
    $('#prepare-sources').replaceChildren();
  }
  const interpretationDrafts = new Map();
  const o = () => getState().opportunities.find((v) => v.id === selected),
    packet = () => getState().applications.find((a) => a.opportunityId === selected);
  const request = async (path, body) => setState(await api(path, body));
  const mailAction = (fn, notificationId) =>
    action(fn).then(() => {
      const status = $('#notice');
      if (status.classList.contains('error')) {
        status.tabIndex = -1;
        status.focus();
      } else if (notificationId) {
        [...document.querySelectorAll('[data-notification-action]')]
          .find((el) => el.dataset.notificationAction === notificationId)
          ?.focus();
      }
    });
  const download = (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = n('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function select(id) {
    if (id === selected) {
      render();
      return true;
    }
    if (packetDirty || replyDirty || emailDirty) {
      notice(
        'Save your packet/reply draft and send or clear your application email before switching jobs.',
        true,
      );
      return false;
    }
    invalidatePreparation();
    clearPreparationReferences();
    $('#prepare-consent').checked = false;
    $('#prepare-questions').value = '';
    selected = id;
    emailJob = '';
    packetKey = '';
    replyId = null;
    replyDirty = false;
    packetDirty = false;
    $('#reply-panel').hidden = true;
    $('#cv-files').value = '';
    render();
    return true;
  }
  function fileLinks(root, files, path) {
    for (const file of files) {
      const row = n('p', null, 'help');
      const a = n('a', `${file.name} · ${Math.ceil(file.size / 1024)} KiB`);
      a.href = path + '/' + file.id;
      row.append(a);
      root.append(row);
    }
  }
  function inboundContentNotes(root, m) {
    if (m.textSource === 'html-extracted')
      root.append(
        n(
          'p',
          'Text extracted from HTML. Review the original email in Resend before relying on formatting or omitted content.',
          'help',
        ),
      );
    if (m.textSource === 'html-source')
      root.append(
        n(
          'p',
          'HTML source shown as text. Review the original email in Resend for readable formatting.',
          'help',
        ),
      );
    if (m.textTruncated || m.contentTruncated)
      root.append(
        n(
          'p',
          'Email content is truncated. Review the complete original email in Resend.',
          'warning',
        ),
      );
    for (const file of m.attachments ?? [])
      root.append(
        n(
          'p',
          `${file.name} · ${file.type} · ${Math.ceil(file.size / 1024)} KiB · not downloaded; open in Resend`,
          'help',
        ),
      );
  }
  function viewMessage(m) {
    const article = n('article', null, 'mail-message');
    article.append(
      n(
        'p',
        `${messageOrigin(m)} · ${m.origin === 'gmail-import' ? (m.timeStatus === 'verified' ? new Date(m.direction === 'outbound' ? m.sentAt : m.receivedAt).toLocaleString() : 'Original date ' + (m.timeStatus ?? 'unknown')) : new Date(m.receivedAt).toLocaleString()}`,
        'help',
      ),
      n('h3', m.subject),
      n('p', `${m.from} → ${m.to}`, 'help'),
      n('p', m.text, 'mail-original'),
      n('p', `${m.analysis.kind} · ${m.analysis.method}`, 'help'),
      n('blockquote', m.analysis.excerpt, 'mail-excerpt'),
    );
    fileLinks(article, m.files, '/api/message-files/' + m.id);
    inboundContentNotes(article, m);
    if (m.origin === 'gmail-import') {
      const historicalAttempt = getState().historicalAttempts?.find(
        (attempt) => attempt.messageId === m.id,
      );
      if (historicalAttempt)
        article.append(
          n(
            'p',
            'Historical application sent via ' +
              historicalAttempt.channel +
              ' · delivery unverified',
            'help',
          ),
        );
      const recipients = m.originalRecipients;
      if (recipients)
        article.append(
          n(
            'p',
            'Original recipients: to ' +
              recipients.to.join(', ') +
              '; cc ' +
              recipients.cc.join(', ') +
              '; bcc ' +
              recipients.bcc.join(', '),
            'help',
          ),
        );
      for (const file of m.files)
        article.append(n('p', file.name + ' · SHA256 ' + file.sha256, 'help'));
      for (const ref of m.attachmentRefs ?? [])
        if (ref.unavailable)
          article.append(n('p', ref.name + ' · unavailable: ' + ref.reason, 'help'));
      article.append(
        n(
          'p',
          'Historical evidence · read only. Reply or manage the original conversation in its source mailbox. No new application stage was inferred.',
          'help',
        ),
      );
      return article;
    }
    const savedReply = getState().replyDrafts.find((d) => d.messageId === m.id);
    if (savedReply)
      article.append(
        n(
          'p',
          getState().mailDispatches?.some(
            (d) => d.messageId === m.id && d.replyRevision === savedReply.revision,
          )
            ? 'Saved reply · delivery attempt recorded below'
            : 'Saved reply draft · not sent',
          'help',
        ),
        n('p', savedReply.body, 'mail-original'),
      );
    const correction = n('details');
    correction.open = interpretationDrafts.has(m.id);
    correction.append(n('summary', 'Correct interpretation'));
    const form = n('form', null, 'interpretation-form');
    const draft = interpretationDrafts.get(m.id) ?? {
      revision: m.revision,
      kind: m.analysis.kind,
      excerpt: m.text.includes(m.analysis.excerpt) ? m.analysis.excerpt : '',
    };
    const kind = n('select');
    kind.id = 'kind-' + m.id;
    for (const value of [
      'interview',
      'rejection',
      'question',
      'assignment',
      'acknowledgment',
      'bounce',
      'needs-review',
    ]) {
      const option = n('option', value);
      option.value = value;
      kind.append(option);
    }
    kind.value = draft.kind;
    const kindLabel = n('label', 'Message type');
    kindLabel.htmlFor = kind.id;
    const excerpt = n('textarea');
    excerpt.id = 'excerpt-' + m.id;
    excerpt.rows = 2;
    excerpt.maxLength = 500;
    excerpt.value = draft.excerpt;
    const quoteLabel = n('label', 'Supporting excerpt');
    quoteLabel.htmlFor = excerpt.id;
    kind.onchange = excerpt.oninput = () => {
      draft.kind = kind.value;
      draft.excerpt = excerpt.value;
      interpretationDrafts.set(m.id, draft);
    };
    const save = n('button', 'Save interpretation');
    save.type = 'submit';
    form.append(
      kindLabel,
      kind,
      quoteLabel,
      excerpt,
      n(
        'p',
        'Copy a short exact quotation from the original. This changes the suggestion, not your application stage.',
        'help',
      ),
      save,
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      interpretationDrafts.set(m.id, draft);
      action(async () => {
        await request('/api/mail/analysis/' + m.id, {
          revision: draft.revision,
          kind: kind.value,
          excerpt: excerpt.value,
        });
        interpretationDrafts.delete(m.id);
        notice('Interpretation corrected. Application stage unchanged.');
      });
    };
    const discard = n('button', 'Discard correction and reload', 'text-button');
    discard.type = 'button';
    discard.onclick = () =>
      action(async () => {
        setState(await api('/api/state', undefined, 'GET'));
        interpretationDrafts.delete(m.id);
        notice('Correction draft discarded; original message reloaded.');
      });
    form.append(discard);
    correction.append(form);
    article.append(correction);
    const reply = n('button', 'Prepare reply', 'secondary');
    reply.onclick = () => {
      if (replyDirty) {
        notice('Save the current reply draft before opening another reply.', true);
        return;
      }
      replyId = m.id;
      $('#reply-send-confirm').checked = false;
      const saved = getState().replyDrafts.find((d) => d.messageId === m.id);
      replyRevision = saved?.revision ?? 0;
      $('#reply-to').value = m.from;
      $('#reply-body').value =
        saved?.body ??
        (m.analysis.kind === 'interview'
          ? 'Thank you for the invitation. Could you please share the available interview times and format?'
          : m.analysis.kind === 'rejection'
            ? 'Thank you for letting me know.'
            : 'Thank you for your message.');
      replyDirty = false;
      $('#reply-panel').hidden = false;
      $('#reply-body').focus();
      renderTransport();
    };
    article.append(reply);
    return article;
  }
  function messageOrigin(m) {
    return m.origin === 'gmail-import'
      ? 'Imported Gmail history · ' +
          (m.direction === 'outbound' ? 'sent, delivery unverified' : 'received')
      : m.origin === 'test'
        ? 'Local test message'
        : m.origin === 'manual'
          ? 'Manually supplied · unverified'
          : 'Received through connected mail provider';
  }
  function renderTransport() {
    const state = getState(),
      transport = state.mailTransport ?? {},
      ready = transport.simulated || (transport.sendReady ?? transport.liveReady ?? false),
      a = packet(),
      job = o(),
      realJob = job && job.runMode !== 'fixture';
    $('#mail-transport-status').textContent =
      transport.note ?? 'Mail provider not connected. Live sending and reception are disabled.';
    if (transport.simulated) {
      $('#mail-transport-status').textContent =
        'Controlled local simulation. No external email is sent.';
      document.querySelector('label[for="application-email-to"]').textContent = 'Recipient email';
      $('#application-email-subject').value ||= 'Controlled application';
      $('#application-email-body').value ||= 'Please review this synthetic application.';
      $('#simulate-invitation').textContent = 'Simulate reply';
    }
    if (ready && !transport.simulated)
      $('#mail-transport-status').textContent +=
        ` Sending from ${transport.from ?? 'configured address'}. Receiving ${transport.receiveReady ? 'enabled' : 'not configured'}.`;
    if (emailJob !== selected && !emailDirty) {
      emailJob = selected;
      $('#application-email-form').reset();
    }
    const preview = $('#application-email-packet');
    preview.replaceChildren();
    if (a) {
      preview.append(
        n('p', `${a.cvVersion} · saved packet revision ${a.revision}`, 'help'),
        n('p', a.cvText, 'mail-original'),
        n('p', a.coverLetter, 'mail-original'),
        n('p', a.answers, 'mail-original'),
      );
      for (const file of a.files)
        preview.append(n('p', `${file.name} · ${Math.ceil(file.size / 1024)} KiB`, 'help'));
    } else
      preview.append(n('p', 'No saved packet. Save the CV text or files above first.', 'help'));
    if (reviewedPacket !== `${selected}:${a?.revision ?? 0}`)
      $('#application-email-confirm').checked = false;
    const send = $('#application-send');
    send.textContent = transport.simulated
      ? 'Simulate application email'
      : ready
        ? 'Send application email'
        : 'Send application email — not connected';
    send.disabled =
      sending ||
      !ready ||
      !realJob ||
      !a ||
      packetDirty ||
      !$('#application-email-confirm').checked;
    $('#application-send-help').textContent = transport.simulated
      ? 'Simulation only: confirm the recipient and saved packet. No external email will be sent.'
      : !ready
        ? 'Connect and authorize a verified mail provider before sending.'
        : !realJob
          ? 'Fictional jobs cannot send real email.'
          : packetDirty
            ? 'Save packet edits before reviewing and sending.'
            : !a
              ? 'Save a packet before sending.'
              : `${!$('#application-email-confirm').checked ? 'Review the saved packet, then check the send confirmation. ' : ''}Sends saved packet revision ${a.revision}. ${transport.recipientAllowlist?.length ? 'Allowed test recipients: ' + transport.recipientAllowlist.join(', ') + '.' : transport.recipientRestricted ? 'Controlled beta: sending is limited to the operator’s test recipient.' : 'Check the employer address before confirming.'}`;
    const draft = getState().replyDrafts.find((d) => d.messageId === replyId),
      reply = $('#reply-send');
    if (reviewedReply !== `${replyId}:${draft?.revision ?? 0}`)
      $('#reply-send-confirm').checked = false;
    reply.textContent = ready ? 'Send saved reply email' : 'Send email — not connected';
    reply.disabled =
      sending ||
      !ready ||
      !realJob ||
      state.messages.find((m) => m.id === replyId)?.origin !== 'resend' ||
      !draft ||
      replyDirty ||
      !$('#reply-send-confirm').checked;
    $('#reply-send-help').textContent = !ready
      ? 'Connect and authorize a verified mail provider before sending.'
      : !realJob
        ? 'Fictional jobs cannot send real email.'
        : state.messages.find((m) => m.id === replyId)?.origin !== 'resend'
          ? 'Only received provider correspondence can receive a real reply. Test and manually supplied messages stay local.'
          : !draft
            ? 'Save this reply draft before reviewing and sending.'
            : replyDirty
              ? 'Save reply edits before reviewing and sending.'
              : !$('#reply-send-confirm').checked
                ? 'Review the saved reply, then check the send confirmation.'
                : `Sends saved reply revision ${draft.revision} to ${draft.to}.`;
    const root = $('#mail-deliveries');
    root.replaceChildren();
    const labels = {
      simulated: 'Simulated; no email sent',
      prepared: 'Prepared; not sent',
      sending: 'Sending; outcome pending',
      accepted: 'Accepted by provider; delivery not confirmed',
      delivered: 'Delivery confirmed by provider',
      unknown: 'Outcome unknown; email may have been sent',
      failed: 'Send failed',
      bounced: 'Delivery bounced',
      rejected: 'Rejected by provider',
    };
    const dispatches = (state.mailDispatches ?? []).filter((d) => d.opportunityId === selected);
    for (const d of [...dispatches].reverse()) {
      const row = n('article', null, 'mail-message');
      row.dataset.dispatchId = d.id;
      row.append(
        n('h4', d.subject),
        n('p', labels[d.status] ?? `Delivery status: ${d.status}`, 'delivery-status'),
        n('p', `To: ${d.to} · ${new Date(d.createdAt).toLocaleString()}`, 'help'),
        n('p', d.body, 'mail-original'),
      );
      if (d.packetRevision)
        row.append(
          n(
            'p',
            `Sent snapshot: packet revision ${d.packetRevision}. Later packet edits do not change this email.`,
            'help',
          ),
        );
      if (d.replyRevision)
        row.append(n('p', `Sent snapshot: reply revision ${d.replyRevision}.`, 'help'));
      if (d.status === 'unknown') {
        const retry = n('button', 'Retry the same email snapshot', 'secondary');
        retry.disabled = sending || !ready;
        retry.onclick = () =>
          action(async () => {
            if (
              !confirm(
                'The email may already have been sent. Retry this exact saved email with the same delivery identity?',
              )
            )
              return;
            sending = true;
            try {
              await request('/api/mail/dispatches/' + d.id + '/retry', {
                revision: d.revision,
                confirm: true,
              });
              notice('Same email snapshot retried. Review the delivery status.');
            } finally {
              sending = false;
            }
          });
        row.append(
          n(
            'p',
            'Check delivery before retrying. This retries the same recipient, content and attachments.',
            'help',
          ),
          retry,
        );
      }
      root.append(row);
    }
    if (!dispatches.length)
      root.append(n('p', 'No application or reply emails sent for this role.', 'help'));
    const notifications = $('#email-notifications');
    notifications.replaceChildren();
    for (const item of [...(state.notifications ?? [])].reverse()) {
      const m = state.messages.find((m) => m.id === item.messageId),
        row = n('article', null, 'attention-item');
      row.dataset.notificationId = item.id;
      row.append(
        n(
          'h4',
          item.kind === 'career-import'
            ? 'Imported items are available; review batch progress'
            : (m?.subject ?? 'New email received'),
        ),
        n('p', item.read ? 'Read' : 'Unread', 'notification-state'),
      );
      const read = n(
        'button',
        item.read ? 'Mark notification unread' : 'Mark notification read',
        'text-button',
      );
      read.dataset.notificationAction = item.id;
      read.onclick = () =>
        mailAction(async () => {
          await request('/api/mail/notifications/' + item.id, {
            revision: item.revision,
            read: !item.read,
          });
          notice('Notification updated. Task and application stage unchanged.');
        }, item.id);
      row.append(read);
      if (item.kind === 'career-import' && item.batchId) {
        const link = n('a', 'Review import progress');
        link.href = '/imports?batch=' + encodeURIComponent(item.batchId);
        row.append(link);
      }
      if (item.opportunityId) {
        const open = n('button', 'Open notified conversation', 'secondary');
        open.onclick = () => {
          if (select(item.opportunityId)) activate('applications');
        };
        row.append(open);
      }
      notifications.append(row);
    }
    if (!notifications.children.length)
      notifications.append(n('p', 'No email notifications.', 'help'));
  }
  function render() {
    const state = getState();
    if (!state) return;
    if (
      preparation &&
      (state.profile?.version !== preparation.profileVersion ||
        (packet()?.revision ?? 0) !== preparation.packetRevision ||
        !state.opportunities.some((v) => v.id === preparation.job))
    ) {
      invalidatePreparation(
        'Saved inputs changed. Prepare again from the current profile and vacancy.',
      );
    }
    $('#prepare-packet').disabled = !!preparation;
    const jobs = state.opportunities ?? [];
    const selector = $('#application-job');
    if (!jobs.some((v) => v.id === selected)) selected = jobs[0]?.id ?? '';
    const optionKey = jobs.map((v) => v.id).join('|');
    if (selector.dataset.key !== optionKey) {
      selector.replaceChildren(
        ...jobs.map((v) => {
          const option = n('option', `${v.snapshot.company} · ${v.snapshot.title}`);
          option.value = v.id;
          return option;
        }),
      );
      selector.dataset.key = optionKey;
    }
    selector.value = selected;
    $('#application-empty').hidden = !!selected;
    $('#application-workspace').hidden = !selected;
    if (selected) {
      const a = packet();
      const key = `${selected}:${a?.revision ?? 0}`;
      $('#application-stale').hidden = !a || a.profileVersion === (state.profile?.version ?? null);
      if (!packetDirty && packetKey !== key) {
        packetRevision = a?.revision ?? 0;
        $('#cv-version').value = a?.cvVersion ?? '';
        $('#cv-text').value = a?.cvText ?? '';
        $('#cover-letter').value = a?.coverLetter ?? '';
        $('#screening-answers').value = a?.answers ?? '';
        pendingFiles = [];
        packetKey = key;
        $('#cv-files').value = '';
      }
      const fileRoot = $('#packet-files');
      fileRoot.replaceChildren();
      fileLinks(fileRoot, a?.files ?? [], '/api/application-files/' + selected);
      if (pendingFiles.length)
        fileRoot.append(
          n(
            'p',
            `${pendingFiles.length} new file(s) ready to replace the saved attachments.`,
            'help',
          ),
        );
      const history = $('#packet-history');
      history.replaceChildren(
        ...(a?.history ?? []).map((h) => {
          const entry = n('details');
          entry.append(
            n(
              'summary',
              `${h.cvVersion} · revision ${h.revision} · ${new Date(h.savedAt).toLocaleString()}`,
            ),
            n('p', h.cvText, 'mail-original'),
            n('p', h.coverLetter, 'mail-original'),
            n('p', h.answers, 'mail-original'),
          );
          fileLinks(entry, h.files, '/api/application-files/' + selected);
          return entry;
        }),
      );
      if (!a?.history.length)
        history.append(n('p', 'Earlier saved revisions will appear here.', 'help'));
      const testTools = $('#test-mail-tools');
      if (testTools.dataset.job !== selected) {
        testTools.open = o()?.runMode === 'fixture';
        testTools.dataset.job = selected;
      }
      $('#test-alias').textContent = state.mailTransport?.receiveReady
        ? `Reply address: op-${state.mailTransport.replyAliasPrefix ?? ''}${selected}@${state.mailTransport.replyDomain}`
        : `Preview only: op-${selected}@apply.example.com · not a working mailbox.`;
      const messages = state.messages.filter((m) => m.opportunityId === selected);
      $('#conversation-messages').replaceChildren(...messages.map(viewMessage));
      if (!messages.length)
        $('#conversation-messages').append(
          n(
            'p',
            'No correspondence yet. Try the local test invitation or add an email in Inbox.',
            'empty',
          ),
        );
      if (replyId && !replyDirty) {
        const d = state.replyDrafts.find((d) => d.messageId === replyId);
        if (d) {
          replyRevision = d.revision;
          $('#reply-body').value = d.body;
        }
      }
    }
    const attention = $('#attention-items');
    attention.replaceChildren();
    const tasks = state.messages.filter(
      (m) => m.origin !== 'gmail-import' && m.opportunityId && m.analysis.action,
    );
    for (const m of tasks) {
      const job = jobs.find((v) => v.id === m.opportunityId);
      const row = n('article', null, 'attention-item');
      row.append(
        n('h3', m.analysis.action),
        n('p', `${job?.snapshot.company ?? 'Saved job'} · ${m.subject}`),
        n('p', messageOrigin(m), 'help'),
        n('p', m.task.done ? 'Completed' : 'Needs attention', 'task-state'),
      );
      const open = n('button', 'Open conversation', 'secondary');
      open.onclick = () => {
        select(m.opportunityId);
        activate('applications');
      };
      const done = n('button', m.task.done ? 'Reopen' : 'Mark done', 'text-button');
      done.onclick = () =>
        action(async () => {
          await request('/api/mail/tasks/' + m.id, {
            revision: m.task.revision,
            done: !m.task.done,
          });
          notice(m.task.done ? 'Task reopened.' : 'Task completed.');
        });
      row.append(open, done);
      if (m.analysis.proposedStage && !(m.origin === 'test' && job?.runMode !== 'fixture')) {
        const proposal = n('button', `Confirm stage: ${m.analysis.proposedStage}`, 'text-button');
        proposal.disabled = job?.stage === m.analysis.proposedStage;
        proposal.onclick = () =>
          action(async () => {
            await request('/api/mail/proposals/' + m.id, {
              revision: m.revision,
              decisionRevision: job.decisionRevision,
            });
            notice('Stage confirmed from the message.');
          });
        row.append(proposal);
      }
      attention.append(row);
    }
    if (!tasks.length) {
      attention.append(
        n(
          'p',
          state.messages.length ? 'No messages need attention yet.' : 'No correspondence yet.',
          'empty',
        ),
      );
      const open = n(
        'button',
        jobs.length ? 'Open application workspace' : 'Find a job to save',
        'secondary',
      );
      open.onclick = () => activate(jobs.length ? 'applications' : 'results');
      attention.append(
        open,
        n(
          'p',
          jobs.length
            ? 'Open a saved role to try a labeled test invitation, or add a received email below.'
            : 'Save a role to keep its correspondence and next actions together.',
          'help',
        ),
      );
    }
    renderTransport();
    const unassigned = $('#unassigned-messages');
    unassigned.replaceChildren();
    for (const m of state.messages.filter((m) => !m.opportunityId)) {
      if (m.origin === 'gmail-import') {
        unassigned.append(viewMessage(m));
        continue;
      }
      const article = n('article', null, 'mail-message');
      article.append(
        n('h3', m.subject),
        n('p', `${m.from} → ${m.to}`, 'help'),
        n('p', m.text, 'mail-original'),
        n('p', messageOrigin(m), 'help'),
      );
      inboundContentNotes(article, m);
      const choice = n('select');
      choice.setAttribute('aria-label', 'Link email to saved job');
      const blank = n('option', 'Choose a saved job');
      blank.value = '';
      choice.append(
        blank,
        ...jobs.map((j) => {
          const option = n('option', `${j.snapshot.company} · ${j.snapshot.title}`);
          option.value = j.id;
          return option;
        }),
      );
      const link = n('button', 'Link to saved job', 'secondary');
      link.onclick = () =>
        action(async () => {
          if (!choice.value) throw Error('Choose the saved job for this email.');
          await request('/api/mail/link/' + m.id, {
            revision: m.revision,
            opportunityId: choice.value,
          });
          notice('Email linked to the selected job.');
        });
      article.append(choice, link);
      unassigned.append(article);
    }
    if (!unassigned.children.length) unassigned.append(n('p', 'No unassigned email.', 'help'));
  }
  $('#application-audit').onclick = () => {
    if (selected) openAudit({ opportunityId: selected });
  };
  $('#application-job').onchange = () => {
    if (packetDirty || replyDirty || emailDirty) {
      $('#application-job').value = selected;
      notice(
        'Save your packet/reply draft and send or clear your application email before switching jobs.',
        true,
      );
      return;
    }
    select($('#application-job').value);
  };
  for (const id of ['#cv-version', '#cv-text', '#cover-letter', '#screening-answers'])
    $(id).oninput = () => {
      invalidatePreparation(
        'Draft edited. Late preparation results will not replace your changes.',
      );
      if (preparedReferences) delete preparedReferences.preparedRequestId;
      packetDirty = true;
      $('#application-email-confirm').checked = false;
      renderTransport();
    };
  $('#reply-body').oninput = () => {
    invalidatePreparation('Reply edited. Late preparation results will not replace your changes.');
    replyDirty = true;
    $('#reply-send-confirm').checked = false;
    renderTransport();
  };
  $('#cv-files').onchange = () =>
    action(async () => {
      invalidatePreparation(
        'Attachments changed. Late preparation results will not replace your changes.',
      );
      const files = [...$('#cv-files').files];
      if (files.length > 2 || files.some((f) => f.size > 262144))
        throw Error('Use up to two PDF/text files, 256 KiB each.');
      pendingFiles = await Promise.all(
        files.map(
          (f) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(Error('Could not read this file. Select it again.'));
              reader.onload = () =>
                resolve({
                  name: f.name,
                  type: f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'text/plain'),
                  base64: String(reader.result).split(',')[1],
                });
              reader.readAsDataURL(f);
            }),
        ),
      );
      packetDirty = true;
    });
  $('#prepare-cancel').onclick = () => invalidatePreparation();
  for (const id of ['#prepare-questions', '#prepare-consent'])
    $(id).addEventListener('input', () =>
      invalidatePreparation('Preparation inputs changed. Prepare again when ready.'),
    );
  $('#prepare-packet').onclick = async () => {
    if (preparation) return;
    if (packetDirty || replyDirty || emailDirty || pendingFiles.length) {
      preparationStatus(
        'Save or discard your packet and reply edits, and send or clear your email draft before preparing.',
      );
      return;
    }
    const current = getState();
    if (!current.preparation?.available && o()?.runMode !== 'fixture') {
      preparationStatus(
        'Preparation is not connected. You can still edit and save a packet manually.',
      );
      return;
    }
    if (!selected || !current.profile?.version || !current.profile.facts?.length) {
      preparationStatus('Save confirmed facts in your profile and select a saved vacancy first.');
      return;
    }
    if (!$('#prepare-consent').checked) {
      preparationStatus('Confirm permission to use these inputs for this preparation.');
      return;
    }
    const questions = $('#prepare-questions')
      .value.split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
    if (questions.length > 10 || questions.some((v) => v.length > 1000)) {
      preparationStatus('Use up to 10 questions, each no longer than 1,000 characters.');
      return;
    }
    const active = {
      job: selected,
      profileVersion: current.profile.version,
      packetRevision: packet()?.revision ?? 0,
      requestId: crypto.randomUUID(),
      epoch: ++preparationEpoch,
    };
    preparation = active;
    $('#prepare-packet').disabled = true;
    $('#prepare-cancel').hidden = false;
    preparationStatus('Preparing an editable draft. Your saved packet remains unchanged.');
    try {
      const result = await api('/api/applications/' + active.job + '/prepare', {
        baseRevision: current.revision,
        revision: active.packetRevision,
        profileVersion: active.profileVersion,
        questions,
        consent: true,
        requestId: active.requestId,
      });
      if (
        preparation !== active ||
        active.epoch !== preparationEpoch ||
        selected !== active.job ||
        getState().profile?.version !== active.profileVersion ||
        (packet()?.revision ?? 0) !== active.packetRevision ||
        packetDirty ||
        replyDirty ||
        emailDirty
      )
        return;
      const draft = result.draft,
        provenance = result.provenance;
      if (
        !draft ||
        !provenance ||
        provenance.profileVersion !== active.profileVersion ||
        typeof provenance.opportunityHash !== 'string' ||
        !['cvVersion', 'cvText', 'coverLetter', 'answers'].every(
          (key) => typeof draft[key] === 'string',
        )
      )
        throw Error('Invalid preparation response');
      $('#cv-version').value = draft.cvVersion;
      $('#cv-text').value = draft.cvText;
      $('#cover-letter').value = draft.coverLetter;
      $('#screening-answers').value = draft.answers;
      preparedReferences = {
        preparedRequestId: active.requestId,
        preparedProfileVersion: provenance.profileVersion,
        preparedOpportunityHash: provenance.opportunityHash,
      };
      packetDirty = true;
      $('#application-email-confirm').checked = false;
      const sources = $('#prepare-sources');
      sources.replaceChildren(
        n(
          'p',
          provenance.method === 'fixture-grounded-documents-v2'
            ? 'Synthetic preparation; no live AI.'
            : 'AI-selected evidence draft; review.',
          'help',
        ),
        n(
          'p',
          'Method: ' +
            String(provenance.method) +
            '. Profile version ' +
            provenance.profileVersion +
            '. These sources are shown for this draft; after saving, the packet retains its profile version and vacancy snapshot. Review every claim before saving.',
          'help',
        ),
      );
      for (const evidence of provenance.evidence ?? [])
        sources.append(n('p', String(evidence.factId) + ': ' + String(evidence.quote), 'help'));
      $('#prepare-provenance').hidden = false;
      preparationStatus(
        'Draft ready for review. Edit as needed, then save the application packet. Nothing has been sent.',
      );
      renderTransport();
    } catch {
      if (preparation === active) {
        preparationStatus(
          'Preparation could not finish. Your saved packet is unchanged. Check your session and saved inputs, then retry.',
        );
        notice(
          'Preparation could not finish. Your saved packet is unchanged. Check your session and saved inputs, then retry.',
          true,
        );
      }
    } finally {
      if (preparation === active) {
        preparation = null;
        $('#prepare-packet').disabled = false;
        $('#prepare-cancel').hidden = true;
      }
    }
  };
  $('#application-form').onsubmit = (e) => {
    e.preventDefault();
    const savedReferences = preparedReferences ? { ...preparedReferences } : null;
    invalidatePreparation('Packet saving started. Late preparation results will not replace it.');
    action(async () => {
      const previous = packet();
      const savedFiles = previous?.files ?? [];
      let fileData = pendingFiles;
      if (!pendingFiles.length && savedFiles.length) {
        const results = await Promise.all(
          savedFiles.map(async (f) => {
            const r = await fetch('/api/application-files/' + selected + '/' + f.id);
            if (!r.ok) throw Error('Could not retrieve the saved attachment. Retry.');
            const bytes = new Uint8Array(await r.arrayBuffer());
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return { name: f.name, type: f.type, base64: btoa(binary) };
          }),
        );
        fileData = results;
      }
      await request('/api/applications/' + selected, {
        revision: packetRevision,
        ...(savedReferences ?? {}),
        cvVersion: $('#cv-version').value,
        cvText: $('#cv-text').value,
        coverLetter: $('#cover-letter').value,
        answers: $('#screening-answers').value,
        files: fileData,
      });
      packetDirty = false;
      packetKey = '';
      notice('Application packet saved. Nothing submitted.');
    });
  };
  // Reload is explicitly read-only; discard only after a successful fresh read.
  $('#reload-packet').onclick = () =>
    action(async () => {
      invalidatePreparation();
      setState(await api('/api/state', undefined, 'GET'));
      clearPreparationReferences();
      packetDirty = false;
      replyDirty = false;
      replyId = null;
      packetKey = '';
      $('#reply-panel').hidden = true;
      notice('Packet reloaded. Unsaved packet/reply edits discarded.');
    });
  $('#export-packet').onclick = () => {
    const a = packet();
    if (!a) {
      notice('Save an application packet before exporting.', true);
      return;
    }
    download(
      'application-packet.txt',
      `${o().snapshot.company} — ${o().snapshot.title}\nSaved CV version: ${a.cvVersion}\n\nCV\n${a.cvText}\n\nCover letter\n${a.coverLetter}\n\nScreening answers\n${a.answers}\n\nAttached files (download separately): ${a.files.map((f) => f.name).join(', ') || 'None'}\n`,
    );
  };
  $('#simulate-invitation').onclick = () =>
    action(async () => {
      if (getState().mailTransport?.simulated) {
        await request('/api/mail/simulated-reply', { opportunityId: selected });
        notice('Controlled reply received');
        return;
      }
      await request('/api/mail/intake', {
        origin: 'test',
        transportId: 'test-' + crypto.randomUUID(),
        from: 'recruiter@example.com',
        to: `op-${selected}@apply.example.com`,
        subject: 'Interview invitation — local test',
        text: 'We would like to invite you to an interview. Please choose a time.',
      });
      notice('Local test invitation added. No email was received or sent externally.');
    });
  $('#reply-form').onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      await request('/api/mail/replies/' + replyId, {
        revision: replyRevision,
        body: $('#reply-body').value,
      });
      replyDirty = false;
      notice('Reply draft saved. Nothing sent.');
    });
  };
  for (const id of [
    '#application-email-to',
    '#application-email-subject',
    '#application-email-body',
  ])
    $(id).oninput = () => {
      invalidatePreparation(
        'Email edited. Late preparation results will not replace your changes.',
      );
      emailDirty = !!(
        $('#application-email-to').value ||
        $('#application-email-subject').value ||
        $('#application-email-body').value
      );
      $('#application-email-confirm').checked = false;
      renderTransport();
    };
  $('#refresh-email-status').onclick = $('#refresh-email-notifications').onclick = () =>
    action(async () => {
      setState(await api('/api/state', undefined, 'GET'));
      notice('Email status refreshed. Unsaved drafts are kept.');
    });
  $('#application-email-confirm').onchange = () => {
    reviewedPacket = `${selected}:${packet()?.revision ?? 0}`;
    renderTransport();
  };
  $('#reply-send-confirm').onchange = () => {
    reviewedReply = `${replyId}:${getState().replyDrafts.find((d) => d.messageId === replyId)?.revision ?? 0}`;
    renderTransport();
  };
  $('#clear-application-email').onclick = () => {
    $('#application-email-form').reset();
    emailDirty = false;
    renderTransport();
    notice('Application email draft cleared.');
  };
  $('#application-email-form').onsubmit = (e) => {
    e.preventDefault();
    mailAction(async () => {
      const a = packet(),
        job = o();
      if (!a || packetDirty || !$('#application-email-confirm').checked)
        throw Error('Save and review the packet, then confirm this email before sending.');
      sending = true;
      try {
        await request('/api/mail/dispatches', {
          kind: 'application',
          opportunityId: selected,
          packetRevision: a.revision,
          decisionRevision: job.decisionRevision,
          to: $('#application-email-to').value,
          subject: $('#application-email-subject').value,
          body: $('#application-email-body').value,
          confirm: true,
        });
        emailDirty = false;
        $('#application-email-confirm').checked = false;
        notice('Application email recorded. Review delivery status; acceptance is not delivery.');
      } finally {
        sending = false;
      }
    });
  };
  $('#reply-send').onclick = () =>
    mailAction(async () => {
      const draft = getState().replyDrafts.find((d) => d.messageId === replyId);
      if (!draft || replyDirty || !$('#reply-send-confirm').checked)
        throw Error('Save and review the reply, then confirm before sending.');
      sending = true;
      try {
        await request('/api/mail/dispatches', {
          kind: 'reply',
          messageId: replyId,
          replyRevision: draft.revision,
          decisionRevision: o().decisionRevision,
          confirm: true,
        });
        $('#reply-send-confirm').checked = false;
        notice('Reply email recorded. Review its delivery status.');
      } finally {
        sending = false;
      }
    });
  $('#mail-intake-form').onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      await request('/api/mail/intake', {
        origin: 'manual',
        transportId: 'manual-' + crypto.randomUUID(),
        from: $('#mail-from').value,
        to: $('#mail-to').value,
        subject: $('#mail-subject').value,
        text: $('#mail-text').value,
      });
      $('#mail-intake-form').reset();
      notice('Email text saved as manually supplied and unverified.');
    });
  };
  return {
    render,
    select,
    reset: () => {
      invalidatePreparation();
      clearPreparationReferences();
      $('#prepare-consent').checked = false;
      $('#prepare-questions').value = '';
      preparationStatus('Save confirmed facts in your profile before preparing.');
      selected = '';
      emailJob = '';
      emailDirty = false;
      sending = false;
      $('#application-email-form').reset();
      packetKey = '';
      packetDirty = false;
      pendingFiles = [];
      packetRevision = 0;
      replyId = null;
      replyDirty = false;
      interpretationDrafts.clear();
      for (const id of [
        '#cv-version',
        '#cv-text',
        '#cover-letter',
        '#screening-answers',
        '#reply-to',
        '#reply-body',
        '#cv-files',
      ])
        $(id).value = '';
      $('#reply-panel').hidden = true;
    },
  };
}
