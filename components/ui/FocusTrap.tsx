"use client";

import { useEffect, useRef } from "react";

interface FocusTrapProps {
  children: React.ReactNode;
  active?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement>;
}

/**
 * FocusTrap - A simple focus trap for modal dialogs
 *
 * Traps keyboard focus within the children elements when active.
 * Prevents focus from moving outside the modal.
 */
export function FocusTrap({ children, active = true, initialFocusRef }: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    // Store the element that had focus before the trap activated
    const previousFocus = document.activeElement as HTMLElement;
    previousFocusRef.current = previousFocus;

    // Focus the initial element or the first focusable element
    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    const focusableElements = containerRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
    const firstFocusable = focusableElements?.[0];
    const lastFocusable = focusableElements?.[focusableElements.length - 1];

    // Move focus to initial focus ref or first focusable element
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else if (firstFocusable) {
      firstFocusable.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      // Get current focus
      const currentFocus = document.activeElement as HTMLElement;
      const focusableContainer = containerRef.current;

      if (!focusableContainer) return;

      const allFocusable = focusableContainer.querySelectorAll<HTMLElement>(focusableSelector);
      const firstElement = allFocusable[0];
      const lastElement = allFocusable[allFocusable.length - 1];

      // Shift + Tab: move to last element if on first
      if (e.shiftKey) {
        if (currentFocus === firstElement || !focusableContainer.contains(currentFocus)) {
          e.preventDefault();
          lastElement?.focus();
        }
      }
      // Tab: move to first element if on last
      else {
        if (currentFocus === lastElement || !focusableContainer.contains(currentFocus)) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to the element that had focus before
      previousFocusRef.current?.focus();
    };
  }, [active, initialFocusRef]);

  return <div ref={containerRef}>{children}</div>;
}

/**
 * Returns the first focusable element within a container
 */
export function getFirstFocusable(container: Element): HTMLElement | null {
  const focusableSelector =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusable = container.querySelectorAll<HTMLElement>(focusableSelector);
  return focusable[0] || null;
}

/**
 * Returns the last focusable element within a container
 */
export function getLastFocusable(container: Element): HTMLElement | null {
  const focusableSelector =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusable = container.querySelectorAll<HTMLElement>(focusableSelector);
  return focusable[focusable.length - 1] || null;
}