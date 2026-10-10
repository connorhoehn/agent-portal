# A/B overlay: the cluster-real-send-validation image with ONLY the
# realtime-modules presence-lane build (perf/presence-frame-lane) copied over
# the four affected dist modules (+ their typings). Nothing else changes.
FROM orgiq-middleware:cluster-real-send-validation
COPY dist/ /app/node_modules/@connorhoehnslalom/realtime-modules/dist/
