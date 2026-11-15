// Demo-only preload for the live take of the Milo demo film (scripts/demo/assistant-meeting-film.mjs --live), loaded through NODE_OPTIONS
// into the film's own middleware and nowhere else. With MEETING_ASSISTANT_LIVE=1 the decision watcher's model check goes to
// Bedrock; the film keeps that one check on its scripted stand-in (ScriptedDecisionModel) through the module's own injection seam
// (setDecisionModelFactory), so the watcher still runs on the real transcript and only the yes/no judgement is scripted.
//
// FILM_DECISION_MODULE names the decision-model module file. The import waits a few seconds, so tsx's loader is registered and the
// server has loaded the same module instance; a process without that loader (tsx's own launcher) fails the import and is left alone.
import { pathToFileURL } from 'node:url';

const target = process.env.FILM_DECISION_MODULE;
if (target) {
  const timer = setTimeout(async () => {
    try {
      const m = await import(pathToFileURL(target).href);
      m.setDecisionModelFactory(() => new m.ScriptedDecisionModel());
      console.log(`[film] decision checks use the scripted stand-in (${m.makeDecisionModel().kind})`);
    } catch {
      // Not the server process.
    }
  }, 5000);
  timer.unref?.();
}
