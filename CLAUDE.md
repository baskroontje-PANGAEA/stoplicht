# Stoplicht — ontwikkelrichtlijnen

## Versienummer

Bij **elke wijziging** die gecommit wordt: bump het versienummer in `components/Detector.tsx`:

```typescript
const VERSION = '1.x.y';
```

Gebruik semantic versioning (major.minor.patch):
- **patch** (1.5.x): bugfix, kleine aanpassing
- **minor** (1.x.0): nieuwe functie of zichtbare gedragswijziging
- **major** (x.0.0): grote herstructurering

Het versienummer is zichtbaar in de app (linksboven) — zo is altijd te zien welke versie op de telefoon draait.
