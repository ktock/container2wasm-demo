#!/bin/bash

set -euo pipefail

SOURCE=./src/
DEST=./out/

for I in $(ls -1 ${SOURCE}) ;
do
    OUTPUT_NAME="${I}-container"
    if [ -f "${SOURCE}/${I}/image" ]; then
        c2w --to-js --build-arg JS_OUTPUT_NAME=${OUTPUT_NAME} "$(cat ${SOURCE}/${I}/image)" "${DEST}"
    elif [ -f "${SOURCE}/${I}/Dockerfile" ]; then
        cat ${SOURCE}/${I}/Dockerfile | docker buildx build --progress=plain -t ${I} --platform=linux/riscv64 --load -
        c2w --to-js --build-arg JS_OUTPUT_NAME=${OUTPUT_NAME} "${I}" "${DEST}"
    else
        echo "no image source found for ${I}"
        exit 1
    fi
done
