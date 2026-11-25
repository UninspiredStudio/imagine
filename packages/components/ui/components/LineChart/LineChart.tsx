"use client";
/*
 * Documentation:
 * Line Chart — https://app.subframe.com/c34b194ceab2/library?component=Line+Chart_22944dd2-3cdd-42fd-913a-1b11a3c1d16d
 */

import React from "react";
import * as SubframeCore from "@subframe/core";
import * as SubframeUtils from "../../utils";

export interface LineChartRootProps
  extends React.ComponentProps<typeof SubframeCore.LineChart> {
  className?: string;
}

const LineChartRoot = React.forwardRef<
  React.ElementRef<typeof SubframeCore.LineChart>,
  LineChartRootProps
>(function LineChartRoot(
  { className, ...otherProps }: LineChartRootProps,
  ref
) {
  return (
    <SubframeCore.LineChart
      className={SubframeUtils.twClassNames("h-80 w-full", className)}
      ref={ref}
      colors={[
        "#7a6de6",
        "#e3dffb",
        "#5b4fe0",
        "#c9c2f6",
        "#4a3fcb",
        "#a196ee",
      ]}
      {...otherProps}
    />
  );
});

export const LineChart = LineChartRoot;
