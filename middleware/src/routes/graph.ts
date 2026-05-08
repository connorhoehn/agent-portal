import { Router } from 'express';
import { mockPeople, mockRelationships, departments } from '../mock/people.js';

export const graphRouter = Router();

graphRouter.get('/entities', (_req, res) => {
  res.json({
    nodes: mockPeople,
    edges: mockRelationships,
    departments,
  });
});

graphRouter.get('/people/:personId', (req, res) => {
  const person = mockPeople.find(p => p.id === req.params['personId']);
  if (!person) { res.status(404).json({ error: 'Person not found' }); return; }

  const connections = mockRelationships
    .filter(r => r.source === person.id || r.target === person.id)
    .map(r => {
      const otherId = r.source === person.id ? r.target : r.source;
      const other = mockPeople.find(p => p.id === otherId);
      return { ...r, otherPerson: other ? { id: other.id, name: other.name, title: other.title } : null };
    });

  res.json({ ...person, connections });
});
