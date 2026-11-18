// Demo-only preload for the Candidates call film (scripts/demo/interviews-call-film.mjs), loaded through NODE_OPTIONS into the
// film's own middleware and nowhere else. With MEETING_ASSISTANT_LIVE=1 (Milo on the provider's live session) the interviews
// coach would go to Bedrock; the film keeps the coach, and with it Milo's private answers, the recap and the plan (they follow
// the coach's kind), on the mock world's scripted stand-in through the module's own injection seam (setCoachModelFactory).
//
// FILM_COACH_MODULE names the coach model module file. The import waits a few seconds, so tsx's loader is registered and the
// server has loaded the same module instance; a process without that loader fails the import and is left alone.
import { pathToFileURL } from 'node:url';

const target = process.env.FILM_COACH_MODULE;
if (target) {
  const timer = setTimeout(async () => {
    try {
      const m = await import(pathToFileURL(target).href);
      m.setCoachModelFactory(() => new m.ScriptedCoachModel());
      console.log(`[film] the interviews coach uses the scripted stand-in (${m.makeCoachModel().kind})`);
    } catch {
      // Not the server process.
    }
  }, 5000);
  timer.unref?.();
}
