#!/bin/zsh
# 0.110 image, metrics mode, default sockets (50). A = BFF defaults (peer
# linger 500 ms, index writes each); B = A + SOCIAL_CHAT_INDEX_WRITES=transaction.
E=${0:A:h}
export ORGIQ_BFF_CONTAINER_IMAGE=orgiq-middleware:cluster-0110-validation
unset ORGIQ_BFF_CONTAINER_DYNAMO_MAX_SOCKETS
run() { $E/run_profile.sh "$@"; }
export ORGIQ_BFF_CONTAINER_CPUS=1 ORGIQ_BFF_CONTAINER_MEMORY_MIB=1024
unset ORGIQ_BFF_CONTAINER_SOCIAL_CHAT_INDEX_WRITES
run burst burst-0110a-1cpu metrics; run soak soak-0110a-1cpu metrics
export ORGIQ_BFF_CONTAINER_SOCIAL_CHAT_INDEX_WRITES=transaction
run burst burst-0110b-1cpu metrics; run soak soak-0110b-1cpu metrics
ORGIQ_BFF_CONTAINER_ORIGIN_METRICS=1 run burst attrib-burst-0110b-1cpu metrics
