#!/bin/zsh
E=${0:A:h}
export ORGIQ_BFF_CONTAINER_IMAGE=orgiq-middleware:cluster-0110-validation ORGIQ_BFF_CONTAINER_CPUS=2 ORGIQ_BFF_CONTAINER_MEMORY_MIB=4096
unset ORGIQ_BFF_CONTAINER_DYNAMO_MAX_SOCKETS ORGIQ_BFF_CONTAINER_SOCIAL_CHAT_INDEX_WRITES
$E/run_profile.sh burst burst-0110a-2cpu metrics; $E/run_profile.sh soak soak-0110a-2cpu metrics
export ORGIQ_BFF_CONTAINER_SOCIAL_CHAT_INDEX_WRITES=transaction
$E/run_profile.sh burst burst-0110b-2cpu metrics; $E/run_profile.sh soak soak-0110b-2cpu metrics
