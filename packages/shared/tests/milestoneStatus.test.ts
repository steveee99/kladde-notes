import { describe, expect, it } from 'vitest';
import { LinkIndex, extractMeta, milestoneMeta, milestoneProgress, milestoneState, milestoneStatusOf, setMilestoneFields, setTicketFields, ticketMeta } from '../src/index.js';

describe('milestone status and dependencies', () => {
  it('reads status (also German) and both dependency directions', () => {
    const m = milestoneMeta('---\ntype: milestone\nstatus: verworfen\nblocks: ["[[v3]]"]\nblockedBy: ["[[v1]]", "[[v1.5]]"]\n---\n');
    expect(m.status).toBe('cancelled');
    expect(m.blocks).toEqual(['v3']);
    expect(m.blockedBy).toEqual(['v1', 'v1.5']);
    expect(milestoneStatusOf('Abgeschlossen')).toBe('done');
    expect(milestoneStatusOf('whatever')).toBeNull();
  });

  it('derives the state from the tickets unless set by hand', () => {
    expect(milestoneState(null, [])).toBe('planned');
    expect(milestoneState(null, [{ category: 'open' }])).toBe('planned');
    expect(milestoneState(null, [{ category: 'done' }, { category: 'open' }])).toBe('active');
    expect(milestoneState(null, [{ category: 'done' }])).toBe('done');
    expect(milestoneState('cancelled', [{ category: 'active' }])).toBe('cancelled');
  });

  it('is never at risk once done or cancelled', () => {
    const today = new Date(2026, 10, 21);
    const open = [{ category: 'open' as const, estimate: null }];
    expect(milestoneProgress({ start: '2026-10-01', due: '2026-11-01' }, open, today).atRisk).toBe(true);
    expect(milestoneProgress({ start: '2026-10-01', due: '2026-11-01', status: 'done' }, open, today).atRisk).toBe(false);
  });

  it('writes and removes status and dependencies', () => {
    let c = setMilestoneFields('---\ntype: milestone\n---\n', { status: 'active', blockedBy: ['v1'] });
    expect(milestoneMeta(c).status).toBe('active');
    expect(milestoneMeta(c).blockedBy).toEqual(['v1']);
    c = setMilestoneFields(c, { status: null, blockedBy: [] });
    expect(c).not.toMatch(/status|blockedBy/);
  });

  it('keeps blockedBy on tickets', () => {
    const c = setTicketFields('---\ntype: ticket\nid: KLD-2\n---\n', { blockedBy: ['KLD-1'] });
    expect(ticketMeta(c).blockedBy).toEqual(['KLD-1']);
  });
});

describe('frontmatter links', () => {
  it('count as links, so tickets and their docs show in the graph', () => {
    const ticket = '---\ntype: ticket\nmilestone: "[[v2]]"\ndocs: ["[[Spec]]"]\n---\nText';
    expect(extractMeta('P/T.md', ticket).links.sort()).toEqual(['Spec', 'v2']);
    const idx = new LinkIndex([
      { id: 't', path: 'P/T.md', content: ticket },
      { id: 's', path: 'Spec.md', content: 'x' },
      { id: 'm', path: 'P/Meilensteine/v2.md', content: 'y' },
      { id: 'd', path: 'P/_database-0f6b2c1e-1111-4222-8333-444455556666.md', content: '---\ntype: database\n---\n[[T]]' },
    ]);
    const g = idx.graph();
    expect(g.edges).toHaveLength(2);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['m', 's', 't']);
  });
});
