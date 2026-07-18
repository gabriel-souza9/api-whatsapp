#!/bin/sh
set -e
npx prisma db execute --schema prisma/schema.prisma --file prisma/init.sql
npx prisma generate
exec node dist/main.js
