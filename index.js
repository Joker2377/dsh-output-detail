import { z } from 'zod';
import { applyHost } from './lib/host.js';

export const name = 'dsh-output-detail';
export const inject = ['agents', 'commands', 'tools', 'sessionProjections'];

export function apply(ctx) {
  return applyHost(ctx, z);
}
