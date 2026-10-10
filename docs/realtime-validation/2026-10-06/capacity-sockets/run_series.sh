#!/bin/zsh
# usage: run_series.sh <cpus> <memMiB> <sockets...>  — burst then soak per socket cap, metrics mode
E=${0:A:h}; C=$1; MEM=$2; shift 2
for s in "$@"; do
  export ORGIQ_BFF_CONTAINER_CPUS=$C ORGIQ_BFF_CONTAINER_MEMORY_MIB=$MEM
  if [ "$s" = default ]; then unset ORGIQ_BFF_CONTAINER_DYNAMO_MAX_SOCKETS; else export ORGIQ_BFF_CONTAINER_DYNAMO_MAX_SOCKETS=$s; fi
  for p in burst soak; do $E/run_profile.sh $p $p-${C}cpu-s$s metrics; done
done
