import { fireEvent, render, screen } from "@testing-library/react";
import EvidenceThumbnail from "../EvidenceThumbnail";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => <img {...props} />,
}));

it("reserves space and lazy-loads a sized preview before opening the original", () => {
  render(<EvidenceThumbnail cid="bafyExample/document.png" label="loan document" />);
  const preview = screen.getByRole("img", { name: "loan document" });
  const original = screen.getByRole("link", { name: "Open full-size loan document" });
  expect(preview).toHaveAttribute("loading", "lazy");
  expect(preview).toHaveAttribute("sizes", "(max-width: 640px) 80vw, 384px");
  expect(preview).not.toHaveAttribute("src", original.getAttribute("href"));
  expect(original).toHaveClass("aspect-[4/3]");
  expect(original).toHaveAttribute("href", "https://ipfs.io/ipfs/bafyExample/document.png");
  expect(screen.getByTestId("evidence-thumbnail-placeholder")).toBeInTheDocument();
  fireEvent.load(preview);
  expect(screen.queryByTestId("evidence-thumbnail-placeholder")).toBeNull();
});
