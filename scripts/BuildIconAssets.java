import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import javax.imageio.ImageIO;

/** Mechanical export of the approved artwork; does not redraw or crop it. */
class BuildIconAssets {
    public static void main(String[] arguments) throws IOException {
        Path source = Path.of(arguments.length > 0
                ? arguments[0] : "assets/branding/app-icon-source.png");
        BufferedImage original = ImageIO.read(source.toFile());
        if (original == null || original.getWidth() != original.getHeight()) {
            throw new IOException("App icon source must be a square image");
        }
        Path output = Path.of("public/icons");
        Files.createDirectories(output);
        export(original, 512, output.resolve("app-icon.png"));
        export(original, 192, output.resolve("app-icon-192.png"));
        export(original, 64, output.resolve("app-icon-64.png"));
        Path androidIcon = Path.of("android/app/src/main/res/drawable-nodpi/ic_launcher_art.png");
        Files.createDirectories(androidIcon.getParent());
        Files.copy(output.resolve("app-icon.png"), androidIcon, StandardCopyOption.REPLACE_EXISTING);
        System.out.println(androidIcon + " (same 512px artwork)");
    }

    private static void export(BufferedImage original, int size, Path destination)
            throws IOException {
        BufferedImage scaled = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = scaled.createGraphics();
        try {
            graphics.setComposite(AlphaComposite.Src);
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                    RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING,
                    RenderingHints.VALUE_RENDER_QUALITY);
            graphics.drawImage(original, 0, 0, size, size, null);
        } finally {
            graphics.dispose();
        }
        if (!ImageIO.write(scaled, "png", destination.toFile())) {
            throw new IOException("PNG encoder unavailable");
        }
        System.out.println(destination + " (" + size + " x " + size + ")");
    }
}
