import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";

type StableCounterProps = {
  initialCount?: number;
};

export function StableCounter({ initialCount = 0 }: StableCounterProps) {
  const [count, setCount] = useState(initialCount);

  return (
    <View testID="stable-counter.root">
      <Text testID="stable-counter.value">Count: {count}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setCount((value) => value + 1)}
        testID="stable-counter.increment"
      >
        <Text>Increment</Text>
      </Pressable>
    </View>
  );
}
