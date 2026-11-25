"use client";
/*
 * Documentation:
 * Bar Chart — https://app.subframe.com/c34b194ceab2/library?component=Bar+Chart_4d4f30e7-1869-4980-8b96-617df3b37912
 */

import React from "react";
import * as SubframeCore from "@subframe/core";
import * as SubframeUtils from "../../utils";

export interface BarChartRootProps
  extends React.ComponentProps<typeof SubframeCore.BarChart> {
  stacked?: boolean;
  className?: string;
}

const BarChartRoot = React.forwardRef<
  React.ElementRef<typeof SubframeCore.BarChart>,
  BarChartRootProps
>(function BarChartRoot(
  { stacked = false, className, ...otherProps }: BarChartRootProps,
  ref
) {
  return (
    <SubframeCore.BarChart
      className={SubframeUtils.twClassNames("h-80 w-full", className)}
      ref={ref}
      stacked={stacked}
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

export const BarChart = BarChartRoot;
