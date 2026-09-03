// register inference v1 — lexical cues bounded by HIS local clock. The point
// is reachability: `work` and `friend` canon scenes (boundaries, wrong-and-
// owned, friend-mode dinner) become selectable when the frame actually is that.

import { describe, expect, it } from 'vitest';
import { inferRegister } from '../../src/app/register.js';

describe('register inference', () => {
  it('play is the resting register — most messages are just us talking', () => {
    expect(inferRegister('hey — is the box safe?', 15)).toBe('play');
    expect(inferRegister('jaja no me lo puedo creer', 15)).toBe('play');
    expect(inferRegister('', 15)).toBe('play');
  });

  it('a strong work cue alone flips to work', () => {
    expect(inferRegister('mira el stacktrace del server', 15)).toBe('work');
    expect(inferRegister('sube la 2.4.1 a prod', 15)).toBe('work');
    expect(inferRegister('mira: https://github.com/x/y', 15)).toBe('work');
    expect(inferRegister('te pego el log:\n```\ncrash\n```', 15)).toBe('work');
  });

  it('two weak cues read as work, one does not', () => {
    expect(inferRegister('el deploy va bien pero el build tarda', 15)).toBe('work');
    expect(inferRegister('hubo un error con la impresora de la cocina', 15)).toBe('play');
  });

  it('an explicit friend cue outranks work vocabulary', () => {
    expect(inferRegister('amigo qué deploy ni deploy, ven a cenar', 15)).toBe('friend');
  });

  it('the clock modifier: machine talk at 2 a.m. Madrid is conversation, not work mode', () => {
    expect(inferRegister('el deploy va bien pero el build tarda', 2)).toBe('play');
    expect(inferRegister('mira el stacktrace', 2)).toBe('play');
    // inside his working day it is work
    expect(inferRegister('mira el stacktrace', 10.5)).toBe('work');
    expect(inferRegister('mira el stacktrace', 20.9)).toBe('work');
  });

  it('an unknown local hour (no clock) keeps the lexical verdict', () => {
    expect(inferRegister('mira el stacktrace', undefined)).toBe('work');
  });
});
