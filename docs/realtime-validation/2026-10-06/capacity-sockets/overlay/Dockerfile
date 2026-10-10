# Single-variable overlay on the 0.109 image: only the SOCIAL_CHAT_MAX_SOCKETS
# upper bound (256 -> 1024) and explicit keepAlive (already the SDK default)
# change; the default of 50 sockets is unchanged.
FROM orgiq-middleware:cluster-0109-validation
RUN sed -i -e "s/maxSockets > 256)$/maxSockets > 1024)/" \
           -e "s/must be an integer from 1 to 256/must be an integer from 1 to 1024/" \
           -e "s/httpAgent: { maxSockets }, httpsAgent: { maxSockets }/httpAgent: { keepAlive: true, maxSockets }, httpsAgent: { keepAlive: true, maxSockets }/" /app/dist/lib/realtime-gateway.js \
 && grep -q "maxSockets > 1024)" /app/dist/lib/realtime-gateway.js && grep -q "keepAlive: true, maxSockets" /app/dist/lib/realtime-gateway.js
