import type { Plugin } from 'vite';

// The pinned 2.439 call host has no pre-join layout slot. Keep this narrow,
// reviewable build patch until the shared library ships a two-column layout.
// It changes the existing library form and Modal, never the call/device runtime.
// The package stays excluded from Vite dependency prebundling so this runs in
// development and production. A changed upstream structure fails visibly.
function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`Tenant pre-join patch no longer matches ui-components: ${before.slice(0, 75)}`);
  return source.replace(before, after);
}

export function patchTenantPrejoin(source: string, id: string): string | null {
  id = id.split('?')[0]!;
  if (!id.includes('/@connorhoehnslalom/ui-components/dist/')) return null;
  if (id.endsWith('/integrations/realtime.js')) {
    source = replaceOnce(source, 'kind: s, title: c, selfName: l, initial: u,', 'kind: s, title: c, selfName: l, selfAvatarUrl: selfAvatarUrl, initial: u,');
    source = replaceOnce(source, 'selfName: e?.displayName ?? "",', 'selfName: e?.displayName ?? "",\n\t\t\t\t\tselfAvatarUrl: e?.avatarUrl,');
    let next = replaceOnce(source, 'maxWidth: 560,\n\t\t\tbackdropTestId: "prejoin-backdrop",',
      'maxWidth: 900,\n\t\t\tcardClassName: "work-prejoin flex max-h-[88vh] flex-col overflow-hidden border border-border",\n\t\t\trawChildren: !0,\n\t\t\tbackdropTestId: "prejoin-backdrop",');
    next = replaceOnce(next, 'title: `${Qe[s]} — ${c}`,', 'title: s === "check" ? "Check your devices" : s === "accept" ? "Join the huddle" : "Start a huddle",');
    next = replaceOnce(next, 'gap: "md",\n\t\t\t\t"data-testid": "prejoin-dialog",',
      'gap: "md",\n\t\t\t\tclassName: "min-h-0 overflow-y-auto",\n\t\t\t\t"data-testid": "prejoin-dialog",');
    next = replaceOnce(next, 'children: [\n\t\t\t\t\t/* @__PURE__ */ X(Se, {',
      'children: [X(n, { justify: "between", align: "center", gap: "md", className: "work-prejoin-context", children: [X(a, { size: "sm", weight: "semibold", children: c }), X(a, { size: "xs", tone: "secondary", children: "Joining as " + l })] }),\n\t\t\t\t\t/* @__PURE__ */ X(Se, {');
    next = replaceOnce(next, 'selfName: l,\n\t\t\t\t\t\t"data-testid": "prejoin-devices"',
      'selfName: l,\n\t\t\t\t\t\tselfAvatarUrl: selfAvatarUrl,\n\t\t\t\t\t\tlayout: "prejoin",\n\t\t\t\t\t\t"data-testid": "prejoin-devices"');
    next = replaceOnce(next, 'children: "Microphone on"', 'children: p.micOn ? "Microphone on" : "Microphone off"');
    next = replaceOnce(next, 'children: "Camera on"', 'children: p.cameraOn ? "Camera on" : "Camera off"');
    next = replaceOnce(next, 'children: "Remember these choices and skip this check next time"', 'children: "Skip device setup next time"');
    return next;
  }
  if (!/\/AudioVideoSettingsForm-[^/]+\.js$/.test(id)) return null;
  const start = source.indexOf('function Ct({ value: n, onChange: r, devices: i,');
  if (start < 0) throw new Error('Tenant pre-join form patch needs review for this ui-components build');
  const prefix = source.slice(0, start);
  let form = source.slice(start);
  form = replaceOnce(form, 'className: h, "data-testid": g = "audio-video-settings-form"',
    'className: h, layout: layout = "stack", "data-testid": g = "audio-video-settings-form"');
  form = replaceOnce(form, 'className: e("flex flex-col", h),',
    'className: e(layout === "prejoin" ? "grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-6" : "flex flex-col", h),');
  form = replaceOnce(form, 'className: "relative aspect-[338/156] w-full overflow-hidden rounded-lg bg-video-stage",',
    'className: layout === "prejoin" ? "relative aspect-video w-full overflow-hidden rounded-xl bg-video-stage" : "relative aspect-[338/156] w-full overflow-hidden rounded-lg bg-video-stage",');
  // Semantic sections retain their controls. Camera/preview sits on the left;
  // microphone, speakers and optional advanced controls occupy the right.
  for (const [label, placement] of [
    ['Microphone', 'md:col-start-2 md:row-start-1'],
    ['Speakers', 'md:col-start-2 md:row-start-2'],
    ['Camera', 'md:col-start-1 md:row-start-1 md:row-span-3'],
  ]) {
    const labelAt = form.indexOf(`children: "${label}"`);
    const sectionAt = form.lastIndexOf('V(bt, { children:', labelAt);
    if (labelAt < 0 || sectionAt < 0) throw new Error(`Missing ${label} section in the pre-join patch`);
    const anchor = form.slice(sectionAt, sectionAt + 'V(bt, { children:'.length);
    form = form.slice(0, sectionAt) + anchor.replace('V(bt, { children:',
      `V(bt, { className: layout === "prejoin" ? "${placement} !border-0 !py-0" : undefined, children:`) + form.slice(sectionAt + anchor.length);
  }
  form = replaceOnce(form, 'className: "py-1.5",\n\t\t\t\tchildren:',
    'className: layout === "prejoin" ? "md:col-start-2 md:row-start-3 !border-0 !py-0" : "py-1.5",\n\t\t\t\tchildren:');
  form = replaceOnce(form, 'className: "pt-2.5 pb-0",\n\t\t\t\tchildren:',
    'className: layout === "prejoin" ? "hidden" : "pt-2.5 pb-0",\n\t\t\t\tchildren:');
  return prefix + form;
}

export function tenantPrejoin(): Plugin {
  return {
    name: 'work-tenant-prejoin',
    enforce: 'pre',
    transform(source, id) {
      const code = patchTenantPrejoin(source, id);
      return code === null ? null : { code, map: null };
    },
  };
}
