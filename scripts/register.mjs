// node --import ./scripts/register.mjs scripts/<script>.ts
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
