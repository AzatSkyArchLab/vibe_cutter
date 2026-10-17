import { describe, expect, it } from 'vitest';
import { formatTimecode, frameRate, secondsToFrames, snapToStandardFrameRate } from '../src/domain/time';

describe('время', () => {
  it('таймкод', () => {
    expect(formatTimecode(0, frameRate(25))).toBe('00:00:00:00');
    expect(formatTimecode(25 * 3661 + 7, frameRate(25))).toBe('01:01:01:07');
    expect(formatTimecode(30, frameRate(30000, 1001))).toBe('00:00:01:00');
  });
  it('секунды → кадры устойчивы к float', () => {
    expect(secondsToFrames(10, frameRate(30000, 1001))).toBe(299);
    expect(secondsToFrames(0.1 + 0.2, frameRate(10))).toBe(3);
  });
  it('привязка измеренной частоты к стандартной', () => {
    expect(snapToStandardFrameRate(29.96)).toEqual(frameRate(30000, 1001));
    expect(snapToStandardFrameRate(59.95)).toEqual(frameRate(60000, 1001));
    expect(snapToStandardFrameRate(25.0)).toEqual(frameRate(25));
  });
});
