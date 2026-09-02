// list comprehensions, let(), each, ranges
radii = [for (i = [0:4]) i * 2 + 1];

points = [for (a = [0:30:359]) [10 * cos(a), 10 * sin(a)]];

flattened = [each [1, 2, 3], each [4, 5], 6];

module ring(n=8, r=15) {
    let (step = 360 / n)
        for (i = [0:n-1])
            rotate([0, 0, i * step])
                translate([r, 0, 0])
                    sphere(1);
}

ring(12, 20);

filtered = [for (x = [0:20]) if (x % 2 == 0) x];

nested = [for (x = [0:2]) for (y = [0:2]) [x, y]];
