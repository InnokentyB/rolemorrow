import { organizationSeed } from './organizations.mjs';
import { hash, id, validateAssessment } from './domain.mjs';
import { prepareDispatch, publicDispatch } from './mail-transport.mjs';
import { MailError, mailAction } from './mail.mjs';
export async function seedControlledCatalog(db) {
  if (!db.worker) throw Error('Controlled catalog requires PostgreSQL.');
  const company = organizationSeed({
    name: 'Controlled Tech',
    homepage: 'https://controlled.example',
    careers: 'https://controlled.example/careers',
    industry: 'Developer tools',
  });
  if (await db.organizations.resolve(company)) return;
  await db.organizations.importSeeds([company]);
  await db.worker.startRound();
  const claim = await db.worker.claim();
  if (!claim || claim.organizationId !== company.id)
    throw Error('Controlled fixture queue must be empty before seeding.');
  await db.worker.publish(claim, {
    postings: [
      {
        url: company.careers + '/backend',
        title: 'Controlled Backend Engineer',
        text: 'Build Python services. Operate PostgreSQL and Kubernetes. Remote role in Portugal.',
        location: 'Portugal',
        facts: { country: 'PT', countries: ['PT'], workplaceType: 'Remote' },
        sources: [company.careers],
      },
    ],
    inventory: { urls: [company.careers + '/backend'], sources: [company.careers], complete: true },
    organizationOutcome: {
      status: 'openings-observed',
      openingCount: 1,
      sources: [company.careers],
      ats: [],
    },
  });
}
export function cachedSnapshot(row, profile) {
  const requirements = row.text
    .split('. ')
    .slice(0, 20)
    .filter(Boolean)
    .map((text, index) => ({ id: 'r' + index, text, core: true }));
  const assessment = validateAssessment(
    {
      direction: 'uncertain',
      directionReason:
        'Saved public catalog evidence. No live AI assessment was performed; compare the quoted requirements with your confirmed experience.',
      rows: requirements.map((r) => ({
        requirementId: r.id,
        status: 'unknown',
        factId: null,
        profileQuote: null,
        jobQuote: r.text,
      })),
    },
    { requirements },
    profile,
  );
  return {
    id: row.id,
    key: 'catalog-' + row.id,
    title: row.title,
    text: row.text,
    url: row.url,
    company: row.companyName,
    requirements,
    countries: row.facts?.countries ?? [],
    workMode: row.classification?.workModes?.[0] ?? 'unknown',
    salary: null,
    assessment,
    category: 'review',
    profileVersion: profile.version,
    catalogRevision: row.canonicalRevision,
    catalogId: row.id,
    source: {
      url: row.url,
      linkedFrom: row.sources[0],
      hash: hash(row.text),
      checkedAt: new Date(row.checkedAt).toISOString(),
      authority: 'cached public source; check date applies',
      intakeMethod: 'catalog-snapshot',
    },
  };
}
export function simulateDispatch(state, input) {
  const d = prepareDispatch(state, input, {
    sender: 'simulation@rolemorrow.example',
    replyDomain: 'apply.rolemorrow.example',
  });
  if (d.status === 'prepared') {
    d.status = 'simulated';
    d.revision++;
    d.updatedAt = new Date().toISOString();
  }
  return publicDispatch(d);
}
export function simulateReply(state, input) {
  const d = state.mailDispatches.find(
    (d) => d.opportunityId === input.opportunityId && d.status === 'simulated',
  );
  if (!d) throw new MailError(409, 'Confirm a simulated application before simulating its reply.');
  const transportId = 'simulated-' + d.id;
  if (state.messages.some((m) => m.transportId === transportId)) return;
  mailAction(state, '/api/mail/intake', {
    origin: 'test',
    transportId,
    from: 'recruiter@example.com',
    to: 'op-' + d.opportunityId + '@apply.example.com',
    subject: 'Controlled reply received',
    text: 'Please choose a time for a synthetic interview.',
  });
  const m = state.messages.find((m) => m.transportId === transportId);
  if (!m || m.opportunityId !== d.opportunityId) throw Error('Synthetic correlation failed.');
  state.notifications.push({
    id: id(),
    messageId: m.id,
    opportunityId: m.opportunityId,
    read: false,
    revision: 0,
    createdAt: new Date().toISOString(),
    origin: 'test',
  });
}
