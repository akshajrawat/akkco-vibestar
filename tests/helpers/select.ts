import { fireEvent, screen } from "@testing-library/react";

/** Exercises the real controlled picker rather than dispatching native select changes. */
export const selectValue = (control: HTMLElement, value: string) => {
  fireEvent.click(control);

  const option = screen
    .getAllByRole("option")
    .find((item) => item.getAttribute("data-value") === value);

  if (!option) throw new Error(`Picker option ${value} is unavailable`);
  fireEvent.click(option);
};
