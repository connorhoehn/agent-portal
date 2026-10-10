FROM orgiq-middleware:cluster-real-send-validation
COPY realtime-gateway.ts /app/src/lib/realtime-gateway.ts
RUN npm run build
